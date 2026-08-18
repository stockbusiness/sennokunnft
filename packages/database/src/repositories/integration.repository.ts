import type {
  ConnectionCheckRecord,
  IntegrationEnvironment,
  IntegrationRepository,
  IntegrationSecret,
  IntegrationService,
  IntegrationSettings,
  SecretCipherPort,
  SecretPurpose,
} from '@sengoku/domain';
import type { PrismaClient } from '../../generated/client';
import type {
  IntegrationConnectionCheck as CheckRow,
  IntegrationSecret as SecretRow,
  IntegrationSetting as SettingRow,
} from '../../generated/client';

/**
 * 外部連携の設定と資格情報の保管（指示書 §5・§6）。
 *
 * ⚠️ **平文を返す口は `revealForAdapter` の 1 本だけ。**
 * ほかのメソッドは、暗号文にも触れない形（`IntegrationSecret`）で返す。
 * 一覧や詳細から平文へ辿れないことを、返す型で担保している。
 */

function toSettings(row: SettingRow): IntegrationSettings {
  return {
    id: row.id,
    service: row.service as IntegrationService,
    environment: row.environment as IntegrationEnvironment,
    endpointUrl: row.endpointUrl,
    apiVersion: row.apiVersion,
    timeoutMs: row.timeoutMs,
    maxAttempts: row.maxAttempts,
    enabled: row.enabled,
    rowVersion: row.rowVersion,
  };
}

/**
 * ⚠️ **暗号文をここへ通さない。** 返す形に `ciphertext` が無いことが、
 * 「画面へ流れない」ことの担保になっている。
 */
function toSecret(row: SecretRow): IntegrationSecret {
  return {
    id: row.id,
    service: row.service as IntegrationService,
    environment: row.environment as IntegrationEnvironment,
    purpose: row.purpose as SecretPurpose,
    keyVersion: row.keyVersion,
    lastFour: row.lastFour,
    status: row.status as IntegrationSecret['status'],
    activatedAt: row.activatedAt,
    retiredAt: row.retiredAt,
    createdAt: row.createdAt,
  };
}

function toCheck(row: CheckRow): ConnectionCheckRecord {
  return {
    id: row.id,
    service: row.service as IntegrationService,
    environment: row.environment as IntegrationEnvironment,
    succeeded: row.succeeded,
    failureCode: row.failureCode,
    durationMs: row.durationMs,
    secretId: row.secretId,
    executedByAccountId: row.executedByAccountId,
    correlationId: row.correlationId,
    executedAt: row.executedAt,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
  );
}

export class PrismaIntegrationRepository implements IntegrationRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly cipher: SecretCipherPort,
  ) {}

  async findSettings(
    service: IntegrationService,
    environment: IntegrationEnvironment,
  ): Promise<IntegrationSettings | null> {
    const row = await this.prisma.integrationSetting.findUnique({
      where: { service_environment: { service, environment } },
    });
    return row === null ? null : toSettings(row);
  }

  async listSettings(): Promise<readonly IntegrationSettings[]> {
    const rows = await this.prisma.integrationSetting.findMany({
      orderBy: [{ service: 'asc' }, { environment: 'asc' }],
    });
    return rows.map(toSettings);
  }

  /**
   * 設定を書き戻す。
   *
   * ⚠️ **`rowVersion` を条件に含める。** 読んでから書くまでに他の人が
   * 変えていたら、更新件数が 0 になって `null` を返す。
   * 条件に入れないと、古い画面の内容が黙って上書きする。
   */
  async saveSettings(
    settings: IntegrationSettings,
    expectedRowVersion: number,
    updatedByAccountId: string,
  ): Promise<IntegrationSettings | null> {
    const updated = await this.prisma.integrationSetting.updateMany({
      where: { id: settings.id, rowVersion: expectedRowVersion },
      data: {
        endpointUrl: settings.endpointUrl,
        apiVersion: settings.apiVersion,
        timeoutMs: settings.timeoutMs,
        maxAttempts: settings.maxAttempts,
        enabled: settings.enabled,
        rowVersion: { increment: 1 },
        updatedByAccountId,
      },
    });
    if (updated.count !== 1) {
      return null;
    }
    const row = await this.prisma.integrationSetting.findUniqueOrThrow({
      where: { id: settings.id },
    });
    return toSettings(row);
  }

  /** 設定が無ければ作る。初回アクセスで既定値の行を用意する。 */
  async ensureSettings(
    id: string,
    service: IntegrationService,
    environment: IntegrationEnvironment,
  ): Promise<IntegrationSettings> {
    const row = await this.prisma.integrationSetting.upsert({
      where: { service_environment: { service, environment } },
      create: { id, service, environment },
      // ⚠️ 既にあるなら何も変えない。ここで既定値を書き戻すと設定が消える。
      update: {},
    });
    return toSettings(row);
  }

  async listSecrets(
    service: IntegrationService,
    environment: IntegrationEnvironment,
  ): Promise<readonly IntegrationSecret[]> {
    const rows = await this.prisma.integrationSecret.findMany({
      where: { service, environment },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toSecret);
  }

  async findSecretById(id: string): Promise<IntegrationSecret | null> {
    const row = await this.prisma.integrationSecret.findUnique({ where: { id } });
    return row === null ? null : toSecret(row);
  }

  async findSecretByStatus(
    service: IntegrationService,
    environment: IntegrationEnvironment,
    purpose: SecretPurpose,
    status: 'pending' | 'active',
  ): Promise<IntegrationSecret | null> {
    const row = await this.prisma.integrationSecret.findFirst({
      where: { service, environment, purpose, status },
    });
    return row === null ? null : toSecret(row);
  }

  /**
   * 資格情報を包んで保存する。
   *
   * ⚠️ **平文を受け取るのはここだけ。** 包んだあとは保持しない。
   * ⚠️ 同じ用途に待機中があれば部分UNIQUEが弾く。握りつぶして `null` を返し、
   *    2 通目を作らせない。どちらを有効化するのか決まらなくなるため。
   */
  async createSecret(input: {
    readonly id: string;
    readonly service: IntegrationService;
    readonly environment: IntegrationEnvironment;
    readonly purpose: SecretPurpose;
    readonly plaintext: string;
    readonly createdByAccountId: string;
  }): Promise<IntegrationSecret | null> {
    const sealed = this.cipher.seal(input.plaintext, {
      service: input.service,
      environment: input.environment,
    });

    try {
      const row = await this.prisma.integrationSecret.create({
        data: {
          id: input.id,
          service: input.service,
          environment: input.environment,
          purpose: input.purpose,
          ciphertext: sealed.ciphertext,
          nonce: sealed.nonce,
          authTag: sealed.authTag,
          keyVersion: sealed.keyVersion,
          lastFour: sealed.lastFour,
          status: 'pending',
          createdByAccountId: input.createdByAccountId,
        },
      });
      return toSecret(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        return null;
      }
      throw error;
    }
  }

  /**
   * 入れ替えを 1 トランザクションで書く。
   *
   * ⚠️ **退役を先に書く。** 逆にすると、部分UNIQUE（有効は 1 件）に
   * 阻まれて必ず失敗する。順番が仕様の一部になっている。
   */
  async activateSecret(
    activated: IntegrationSecret,
    retired: IntegrationSecret | null,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      if (retired !== null) {
        await tx.integrationSecret.update({
          where: { id: retired.id },
          data: { status: 'retired', retiredAt: retired.retiredAt },
        });
      }
      await tx.integrationSecret.update({
        where: { id: activated.id },
        data: { status: 'active', activatedAt: activated.activatedAt },
      });
    });
  }

  async updateSecret(secret: IntegrationSecret): Promise<IntegrationSecret> {
    const row = await this.prisma.integrationSecret.update({
      where: { id: secret.id },
      data: {
        status: secret.status,
        activatedAt: secret.activatedAt,
        retiredAt: secret.retiredAt,
      },
    });
    return toSecret(row);
  }

  /**
   * 送信アダプタのためだけに平文を取り出す。
   *
   * ⚠️ **画面・API の応答へ渡さない。** この名前は用途を縛るためにある。
   * ⚠️ 復号できなければ `null`。鍵を失った・改ざんされた場合で、
   *    どちらも「使えない」以上のことを呼び出し側へ伝えない。
   */
  async revealForAdapter(
    service: IntegrationService,
    environment: IntegrationEnvironment,
    purpose: SecretPurpose,
  ): Promise<string | null> {
    const row = await this.prisma.integrationSecret.findFirst({
      where: { service, environment, purpose, status: 'active' },
    });
    if (row === null) {
      return null;
    }
    return this.cipher.open(
      {
        ciphertext: row.ciphertext,
        nonce: row.nonce,
        authTag: row.authTag,
        keyVersion: row.keyVersion,
        lastFour: row.lastFour,
      },
      { service, environment },
    );
  }

  async recordConnectionCheck(record: ConnectionCheckRecord): Promise<void> {
    await this.prisma.integrationConnectionCheck.create({
      data: {
        id: record.id,
        service: record.service,
        environment: record.environment,
        succeeded: record.succeeded,
        failureCode: record.failureCode,
        durationMs: record.durationMs,
        secretId: record.secretId,
        executedByAccountId: record.executedByAccountId,
        correlationId: record.correlationId,
        executedAt: record.executedAt,
      },
    });
  }

  async findLatestConnectionCheck(
    service: IntegrationService,
    environment: IntegrationEnvironment,
  ): Promise<ConnectionCheckRecord | null> {
    const row = await this.prisma.integrationConnectionCheck.findFirst({
      where: { service, environment },
      orderBy: { executedAt: 'desc' },
    });
    return row === null ? null : toCheck(row);
  }

  async listConnectionChecks(
    service: IntegrationService,
    environment: IntegrationEnvironment,
    limit: number,
  ): Promise<readonly ConnectionCheckRecord[]> {
    const rows = await this.prisma.integrationConnectionCheck.findMany({
      where: { service, environment },
      orderBy: { executedAt: 'desc' },
      take: limit,
    });
    return rows.map(toCheck);
  }

  /**
   * 接続先を変えたときに、それまでの成功を無効にする。
   *
   * ⚠️ **消さずに、成功を失敗へ書き換える。** 消すと「いつ何を試したか」が
   * 辿れなくなる。分類コードで、人の操作による失敗ではないことを残す。
   */
  async invalidateConnectionChecks(
    service: IntegrationService,
    environment: IntegrationEnvironment,
    now: Date,
  ): Promise<void> {
    await this.prisma.integrationConnectionCheck.updateMany({
      where: { service, environment, succeeded: true, executedAt: { lte: now } },
      data: { succeeded: false, failureCode: 'SETTINGS_CHANGED' },
    });
  }
}
