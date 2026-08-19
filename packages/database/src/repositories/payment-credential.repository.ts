import {
  isIntegrationEnvironment,
  type ActivateCredentialCommand,
  type IntegrationEnvironment,
  type OpenedPaymentCredential,
  type PaymentCredentialGeneration,
  type PaymentCredentialRepository,
  type RecordCredentialCheckCommand,
  type RegisterCredentialCommand,
  type SealedSecret,
  type SecretCipherPort,
} from '@sengoku/domain';

import type { PrismaClient } from '../../generated/client';

/**
 * 決済資格情報の世代（`UD-118`）。
 *
 * ⚠️ **削除の関数を置かない。** 消すと、その世代で処理した決済の返金経路が
 * 消える。DB 側も `payments.credential_id` の `ON DELETE RESTRICT` で縛る。
 *
 * ⚠️ **復号は `open` 系だけ。** 一覧（`list`）は鍵を読まないので、
 * 画面向けの経路から秘密へ手が届かない。
 */
export class PrismaPaymentCredentialRepository implements PaymentCredentialRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly cipher: SecretCipherPort,
  ) {}

  async list(
    provider: string,
    environment: IntegrationEnvironment,
  ): Promise<readonly PaymentCredentialGeneration[]> {
    const rows = await this.prisma.paymentCredential.findMany({
      where: { provider, environment },
      orderBy: { generation: 'desc' },
    });
    return rows.map(toDomain);
  }

  async findById(id: string): Promise<PaymentCredentialGeneration | null> {
    const row = await this.prisma.paymentCredential.findUnique({ where: { id } });
    return row === null ? null : toDomain(row);
  }

  async register(command: RegisterCredentialCommand): Promise<PaymentCredentialGeneration> {
    /*
      ⚠️ **世代番号は「いまある最大＋1」。** 空きを詰めない。詰めると、
         過去の決済が指している世代と同じ番号を新しい世代が名乗る。
         同時登録は `(provider, environment, generation)` の一意制約が弾く。
    */
    const latest = await this.prisma.paymentCredential.findFirst({
      where: { provider: command.provider, environment: command.environment },
      orderBy: { generation: 'desc' },
      select: { generation: true },
    });

    const row = await this.prisma.paymentCredential.create({
      data: {
        provider: command.provider,
        environment: command.environment,
        generation: (latest?.generation ?? 0) + 1,
        // ⚠️ 登録した時点では何も起きない。戻せる状態を必ず経由させる。
        status: 'pending',
        acceptsNewPayments: false,
        label: command.label,
        apiVersion: command.apiVersion,
        secretKeyCiphertext: command.secretKey.ciphertext,
        secretKeyNonce: command.secretKey.nonce,
        secretKeyAuthTag: command.secretKey.authTag,
        webhookSecretCiphertext: command.webhookSecret.ciphertext,
        webhookSecretNonce: command.webhookSecret.nonce,
        webhookSecretAuthTag: command.webhookSecret.authTag,
        keyVersion: command.secretKey.keyVersion,
        registeredByAccountId: command.registeredByAccountId,
      },
    });
    return toDomain(row);
  }

  async recordCheck(
    command: RecordCredentialCheckCommand,
  ): Promise<PaymentCredentialGeneration | null> {
    const updated = await this.prisma.paymentCredential.updateMany({
      // ⚠️ 退役した世代の確認結果は書かない。
      where: { id: command.id, status: { in: ['pending', 'active'] } },
      data: {
        lastCheckSucceeded: command.succeeded,
        lastCheckAt: command.checkedAt,
        // 失敗したときは前の識別子を消さない（比較に要る）。
        ...(command.accountRef === null ? {} : { accountRef: command.accountRef }),
      },
    });
    return updated.count === 0 ? null : this.findById(command.id);
  }

  async activate(command: ActivateCredentialCommand): Promise<PaymentCredentialGeneration | null> {
    /*
      ⚠️ **1 トランザクションで行う。** 分けると、受付世代が 2 つある瞬間か
         0 の瞬間ができる。前者は入金先が不定、後者は販売停止。
      ⚠️ 旧世代を先に降ろす。逆にすると、部分UNIQUE（受付は 1 世代）に
         引っかかって新世代を立てられない。
    */
    return this.prisma.$transaction(async (tx) => {
      if (command.steppedDownId !== null) {
        const steppedDown = await tx.paymentCredential.updateMany({
          where: { id: command.steppedDownId, acceptsNewPayments: true },
          // ⚠️ `retired` にしない。返金と照会は旧世代の鍵で続く。
          data: { acceptsNewPayments: false },
        });
        if (steppedDown.count === 0) {
          // 途中で受付世代が変わっていた。何も書かずに諦める。
          return null;
        }
      }

      const activated = await tx.paymentCredential.updateMany({
        where: {
          id: command.id,
          status: { in: ['pending', 'active'] },
          // ⚠️ 接続確認を通っていない世代は有効化しない（DB の CHECK と二重）。
          lastCheckSucceeded: true,
        },
        data: {
          status: 'active',
          acceptsNewPayments: true,
          activatedByAccountId: command.activatedByAccountId,
          activatedAt: command.activatedAt,
        },
      });
      if (activated.count === 0) {
        throw new Error('activation rejected');
      }

      const row = await tx.paymentCredential.findUnique({ where: { id: command.id } });
      return row === null ? null : toDomain(row);
    });
  }

  async setAcceptsNewPayments(
    id: string,
    accepts: boolean,
  ): Promise<PaymentCredentialGeneration | null> {
    const updated = await this.prisma.paymentCredential.updateMany({
      where: { id, status: 'active' },
      data: { acceptsNewPayments: accepts },
    });
    return updated.count === 0 ? null : this.findById(id);
  }

  async retire(id: string, retiredAt: Date): Promise<PaymentCredentialGeneration | null> {
    const updated = await this.prisma.paymentCredential.updateMany({
      // ⚠️ 受付中の世代は退役させない（販売が止まる）。
      where: { id, acceptsNewPayments: false },
      data: { status: 'retired', retiredAt },
    });
    return updated.count === 0 ? null : this.findById(id);
  }

  async touchWebhookReceived(id: string, receivedAt: Date): Promise<void> {
    await this.prisma.paymentCredential.updateMany({
      where: { id },
      data: { lastWebhookReceivedAt: receivedAt },
    });
  }

  async open(id: string): Promise<OpenedPaymentCredential | null> {
    const row = await this.prisma.paymentCredential.findUnique({ where: { id } });
    return row === null ? null : this.openRow(row);
  }

  async openForVerification(
    provider: string,
    environment: IntegrationEnvironment,
    limit: number,
  ): Promise<readonly OpenedPaymentCredential[]> {
    /*
      ⚠️ **`retired` も含める。** 切り替え後も、旧アカウントで発生した
         決済の知らせは届き続ける。新しい世代だけ試すと、旧世代の決済が
         「署名が違う」として捨てられる。
    */
    const rows = await this.prisma.paymentCredential.findMany({
      where: { provider, environment },
      orderBy: { generation: 'desc' },
      take: limit,
    });
    const opened: OpenedPaymentCredential[] = [];
    for (const row of rows) {
      const one = this.openRow(row);
      if (one !== null) {
        opened.push(one);
      }
    }
    return opened;
  }

  private openRow(row: CredentialRow): OpenedPaymentCredential | null {
    if (!isIntegrationEnvironment(row.environment)) {
      return null;
    }
    const scope = { service: 'payment' as const, environment: row.environment };
    const secretKey = this.cipher.open(sealed(row, 'secret'), scope);
    const webhookSecret = this.cipher.open(sealed(row, 'webhook'), scope);
    /*
      ⚠️ **開けなかった理由を返さない。** 「鍵が違う」と「改ざん」を
         区別して返すと、総当たりの手掛かりになる。
      ⚠️ ここで例外にしない。1 世代が開けなくても、ほかの世代で
         検証が通る可能性がある。
    */
    if (secretKey === null || webhookSecret === null) {
      return null;
    }
    return {
      id: row.id,
      generation: row.generation,
      secretKey,
      webhookSecret,
      apiVersion: row.apiVersion,
    };
  }
}

interface CredentialRow {
  readonly id: string;
  readonly provider: string;
  readonly environment: string;
  readonly generation: number;
  readonly status: string;
  readonly accountRef: string | null;
  readonly label: string | null;
  readonly apiVersion: string | null;
  readonly secretKeyCiphertext: string;
  readonly secretKeyNonce: string;
  readonly secretKeyAuthTag: string;
  readonly webhookSecretCiphertext: string;
  readonly webhookSecretNonce: string;
  readonly webhookSecretAuthTag: string;
  readonly keyVersion: string;
  readonly lastCheckSucceeded: boolean | null;
  readonly lastCheckAt: Date | null;
  readonly lastWebhookReceivedAt: Date | null;
  readonly acceptsNewPayments: boolean;
  readonly activatedAt: Date | null;
  readonly retiredAt: Date | null;
  readonly createdAt: Date;
}

function sealed(row: CredentialRow, which: 'secret' | 'webhook'): SealedSecret {
  return {
    ciphertext: which === 'secret' ? row.secretKeyCiphertext : row.webhookSecretCiphertext,
    nonce: which === 'secret' ? row.secretKeyNonce : row.webhookSecretNonce,
    authTag: which === 'secret' ? row.secretKeyAuthTag : row.webhookSecretAuthTag,
    keyVersion: row.keyVersion,
    // ⚠️ **末尾 4 文字を持たない**（2026-08-19 決定）。決済では出さない。
    lastFour: '',
  };
}

function toDomain(row: CredentialRow): PaymentCredentialGeneration {
  if (!isIntegrationEnvironment(row.environment)) {
    throw new Error(`unknown environment: ${row.environment}`);
  }
  return {
    id: row.id,
    provider: row.provider,
    environment: row.environment,
    generation: row.generation,
    status: row.status === 'active' ? 'active' : row.status === 'retired' ? 'retired' : 'pending',
    accountRef: row.accountRef,
    label: row.label,
    apiVersion: row.apiVersion,
    lastCheckSucceeded: row.lastCheckSucceeded,
    lastCheckAt: row.lastCheckAt,
    lastWebhookReceivedAt: row.lastWebhookReceivedAt,
    acceptsNewPayments: row.acceptsNewPayments,
    activatedAt: row.activatedAt,
    retiredAt: row.retiredAt,
    createdAt: row.createdAt,
  };
}
