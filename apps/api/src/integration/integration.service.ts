import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  IntegrationListResponse,
  IntegrationStatusView,
  RegisterSecretRequest,
  UpdateIntegrationRequest,
} from '@sengoku/contracts';
import type { Actor } from '@sengoku/auth';
import {
  CHECK_FRESHNESS_MS,
  INTEGRATION_SERVICES,
  activateSecret,
  disableIntegration,
  discardPendingSecret,
  enableIntegration,
  isCheckFresh,
  updateSettings,
  type AuditLogPort,
  type ClockPort,
  type ConnectionCheckRecord,
  type DomainError,
  type IdGeneratorPort,
  type IntegrationEnvironment,
  type IntegrationRepository,
  type IntegrationSecret,
  type IntegrationService,
  type IntegrationSettings,
  type Result,
  type SecretPurpose,
} from '@sengoku/domain';
import { DomainErrorException } from '../common/domain-error.filter';

/**
 * 外部連携の設定と資格情報（管理画面・外部連携 指示書 §4・§6・§9）。
 *
 * ⚠️ **平文をこの層から出さない。** 受け取るのは登録のときだけで、
 * 保管庫へ渡したあとは持たない。応答にも監査ログにも載せない。
 *
 * ⚠️ **判断はドメインが持つ。** 「接続テストの成功が要る」「古い成功では
 * 通さない」といった規則をここへ書き足さない。2 か所に散ると必ずずれる。
 */
@Injectable()
export class IntegrationService_ {
  constructor(
    private readonly repository: IntegrationRepository & {
      ensureSettings(
        id: string,
        service: IntegrationService,
        environment: IntegrationEnvironment,
      ): Promise<IntegrationSettings>;
    },
    private readonly ids: IdGeneratorPort,
    private readonly clock: ClockPort,
    private readonly audit: AuditLogPort,
    /** このプロセスがどの環境か。⚠️ 設定の `environment` とは別物。 */
    private readonly appEnvironment: IntegrationEnvironment,
  ) {}

  /**
   * このプロセスが扱う環境。
   *
   * ⚠️ **要求から受け取らせないための口。** 経路や本文で環境を指定できると、
   * 本番のプロセスから staging の設定を書き換えられる。逆も同じ。
   */
  get appEnvironmentValue(): IntegrationEnvironment {
    return this.appEnvironment;
  }

  async list(): Promise<IntegrationListResponse> {
    const items: IntegrationStatusView[] = [];
    for (const service of INTEGRATION_SERVICES) {
      items.push(await this.status(service, this.appEnvironment));
    }
    return { appEnvironment: this.appEnvironment, items };
  }

  async status(
    service: IntegrationService,
    environment: IntegrationEnvironment,
  ): Promise<IntegrationStatusView> {
    const settings = await this.repository.ensureSettings(
      this.ids.generate(),
      service,
      environment,
    );
    const [secrets, lastCheck] = await Promise.all([
      this.repository.listSecrets(service, environment),
      this.repository.findLatestConnectionCheck(service, environment),
    ]);

    const now = this.clock.now();
    const fresh = isCheckFresh(lastCheck, CHECK_FRESHNESS_MS, now);
    const hasActive = secrets.some((secret) => secret.status === 'active');

    return {
      service,
      environment,
      endpointUrl: settings.endpointUrl,
      apiVersion: settings.apiVersion,
      timeoutMs: settings.timeoutMs,
      maxAttempts: settings.maxAttempts,
      enabled: settings.enabled,
      rowVersion: settings.rowVersion,
      // ⚠️ 暗号文も平文も含めない。含むのは状態と末尾 4 文字だけ。
      secrets: secrets.map(toSecretView),
      lastCheck: lastCheck === null ? null : toCheckView(lastCheck),
      checkFresh: fresh,
      // 画面のボタンを出し分けるための値。⚠️ **これは保護ではない。**
      canEnable: fresh && hasActive && settings.endpointUrl !== null,
    };
  }

  /**
   * 設定を書き換える。
   *
   * ⚠️ **接続先を変えたら、それまでの接続テストの成功を無効にする。**
   * 別の相手に対する成功なので、そのまま有効化を許すと
   * 「テスト済み」の顔をした未確認の接続先が本番に載る。
   */
  async update(
    actor: Actor,
    service: IntegrationService,
    environment: IntegrationEnvironment,
    request: UpdateIntegrationRequest,
  ): Promise<IntegrationStatusView> {
    const actorId = requireActorId(actor);
    const settings = await this.repository.ensureSettings(
      this.ids.generate(),
      service,
      environment,
    );

    const updated = unwrapDomain(
      updateSettings(settings, {
        endpointUrl: request.endpointUrl,
        apiVersion: request.apiVersion,
        timeoutMs: request.timeoutMs,
        maxAttempts: request.maxAttempts,
      }),
    );

    const saved = await this.repository.saveSettings(updated.settings, request.rowVersion, actorId);
    if (saved === null) {
      // 読んでから書くまでに、ほかの人が変えていた。
      throw new DomainErrorException('INTEGRATION_SETTINGS_CONFLICT');
    }

    if (updated.endpointChanged) {
      await this.repository.invalidateConnectionChecks(service, environment, this.clock.now());
    }

    await this.audit.record({
      actorAccountId: actorId,
      action: 'integration.update',
      targetType: 'integration',
      targetId: null,
      // ⚠️ 接続先の値そのものを残さない。ホスト名も業務上の秘密になりうる。
      //    「変えたかどうか」だけを残す（指示書 §10）。
      summary: {
        service,
        environment,
        changed: Object.keys(request).filter((key) => key !== 'rowVersion'),
        endpointChanged: updated.endpointChanged,
      },
    });
    return this.status(service, environment);
  }

  async setEnabled(
    actor: Actor,
    service: IntegrationService,
    environment: IntegrationEnvironment,
    enabled: boolean,
  ): Promise<IntegrationStatusView> {
    const actorId = requireActorId(actor);
    const settings = await this.repository.ensureSettings(
      this.ids.generate(),
      service,
      environment,
    );

    let next: IntegrationSettings;
    if (enabled) {
      const [secrets, lastCheck] = await Promise.all([
        this.repository.listSecrets(service, environment),
        this.repository.findLatestConnectionCheck(service, environment),
      ]);
      next = unwrapDomain(
        enableIntegration({
          settings,
          hasActiveSecret: secrets.some((secret) => secret.status === 'active'),
          lastCheck,
          freshnessMs: CHECK_FRESHNESS_MS,
          now: this.clock.now(),
        }),
      );
    } else {
      // ⚠️ 止めるほうに条件を付けない。事故を止める操作なので、いつでも通す。
      next = disableIntegration(settings);
    }

    const saved = await this.repository.saveSettings(next, settings.rowVersion, actorId);
    if (saved === null) {
      throw new DomainErrorException('INTEGRATION_SETTINGS_CONFLICT');
    }

    await this.audit.record({
      actorAccountId: actorId,
      action: enabled ? 'integration.enable' : 'integration.disable',
      targetType: 'integration',
      targetId: null,
      summary: { service, environment },
    });
    return this.status(service, environment);
  }

  /**
   * 資格情報を登録する。**待機中として保存する。**
   *
   * ⚠️ **いきなり有効にしない。** 間違った値を入れた瞬間に連携が止まり、
   * しかも元の値は再表示できないため戻せない。接続テストを挟ませる。
   *
   * ⚠️ **`request.value` をここから先へ持ち出さない。**
   * 監査ログにもエラーにも載せない。残るのは末尾 4 文字だけ。
   */
  async registerSecret(
    actor: Actor,
    service: IntegrationService,
    environment: IntegrationEnvironment,
    request: RegisterSecretRequest,
  ): Promise<IntegrationStatusView> {
    const actorId = requireActorId(actor);

    const created = await this.repository.createSecret({
      id: this.ids.generate(),
      service,
      environment,
      purpose: request.purpose,
      plaintext: request.value,
      createdByAccountId: actorId,
    });
    if (created === null) {
      // すでに待機中がある。どちらを有効化するのか決まらなくなる。
      throw new DomainErrorException('INTEGRATION_SECRET_NOT_PENDING');
    }

    await this.audit.record({
      actorAccountId: actorId,
      action: 'integration.secret.register',
      targetType: 'integration_secret',
      targetId: created.id,
      // ⚠️ 値そのものは残さない。指示書 §10 の書き方に合わせ、
      //    「何が起きたか」だけを残す。
      summary: {
        service,
        environment,
        purpose: created.purpose,
        lastFour: created.lastFour,
        keyVersion: created.keyVersion,
      },
    });
    return this.status(service, environment);
  }

  /** 待機中の資格情報を有効にする。接続テストの成功が要る。 */
  async activateSecret(actor: Actor, secretId: string): Promise<IntegrationStatusView> {
    const actorId = requireActorId(actor);
    const secret = await this.loadSecret(secretId);

    const [current, lastCheck] = await Promise.all([
      this.repository.findSecretByStatus(
        secret.service,
        secret.environment,
        secret.purpose,
        'active',
      ),
      this.repository.findLatestConnectionCheck(secret.service, secret.environment),
    ]);

    const plan = unwrapDomain(
      activateSecret({
        secret,
        current,
        lastCheck,
        freshnessMs: CHECK_FRESHNESS_MS,
        now: this.clock.now(),
      }),
    );
    await this.repository.activateSecret(plan.activated, plan.retired);

    await this.audit.record({
      actorAccountId: actorId,
      action: 'integration.secret.activate',
      targetType: 'integration_secret',
      targetId: plan.activated.id,
      // 指示書 §10 の書き方（値ではなく、末尾識別子と version の移り変わり）。
      summary: {
        service: secret.service,
        environment: secret.environment,
        purpose: secret.purpose,
        from: current === null ? null : `****${current.lastFour}`,
        to: `****${plan.activated.lastFour}`,
      },
    });
    return this.status(secret.service, secret.environment);
  }

  /** 待機中の資格情報を捨てる（指示書 §7-5「旧versionへ戻す」）。 */
  async discardSecret(actor: Actor, secretId: string): Promise<IntegrationStatusView> {
    const actorId = requireActorId(actor);
    const secret = await this.loadSecret(secretId);
    const discarded = unwrapDomain(discardPendingSecret(secret, this.clock.now()));
    await this.repository.updateSecret(discarded);

    await this.audit.record({
      actorAccountId: actorId,
      action: 'integration.secret.discard',
      targetType: 'integration_secret',
      targetId: discarded.id,
      summary: {
        service: secret.service,
        environment: secret.environment,
        purpose: secret.purpose,
        lastFour: secret.lastFour,
      },
    });
    return this.status(secret.service, secret.environment);
  }

  /**
   * 接続テストの結果を記録する。
   *
   * ⚠️ **PR 1 では記録だけ。** 実際に外部へ繋ぐのは PR 2 以降で、
   * サービスごとの専用処理として書く（指示書 §9）。
   * ここで汎用の「どこへでも繋ぐ」処理を作らない。
   */
  async recordCheck(input: {
    readonly service: IntegrationService;
    readonly environment: IntegrationEnvironment;
    readonly succeeded: boolean;
    readonly failureCode: string | null;
    readonly durationMs: number;
    readonly secretId: string | null;
    readonly actorAccountId: string;
    readonly correlationId: string | null;
  }): Promise<ConnectionCheckRecord> {
    const record: ConnectionCheckRecord = {
      id: this.ids.generate(),
      service: input.service,
      environment: input.environment,
      succeeded: input.succeeded,
      failureCode: input.failureCode,
      durationMs: input.durationMs,
      secretId: input.secretId,
      executedByAccountId: input.actorAccountId,
      correlationId: input.correlationId,
      executedAt: this.clock.now(),
    };
    await this.repository.recordConnectionCheck(record);

    await this.audit.record({
      actorAccountId: input.actorAccountId,
      action: 'integration.connection_check',
      targetType: 'integration',
      targetId: null,
      summary: {
        service: input.service,
        environment: input.environment,
        succeeded: input.succeeded,
        failureCode: input.failureCode,
      },
    });
    return record;
  }

  private async loadSecret(secretId: string): Promise<IntegrationSecret> {
    const secret = await this.repository.findSecretById(secretId);
    if (secret === null) {
      throw new NotFoundException();
    }
    return secret;
  }
}

function toSecretView(secret: IntegrationSecret): {
  id: string;
  purpose: SecretPurpose;
  status: IntegrationSecret['status'];
  lastFour: string;
  keyVersion: string;
  activatedAt: string | null;
  createdAt: string;
} {
  return {
    id: secret.id,
    purpose: secret.purpose,
    status: secret.status,
    lastFour: secret.lastFour,
    keyVersion: secret.keyVersion,
    activatedAt: secret.activatedAt?.toISOString() ?? null,
    createdAt: secret.createdAt.toISOString(),
  };
}

function toCheckView(check: ConnectionCheckRecord): {
  id: string;
  succeeded: boolean;
  failureCode: string | null;
  durationMs: number;
  executedAt: string;
} {
  return {
    id: check.id,
    succeeded: check.succeeded,
    failureCode: check.failureCode,
    durationMs: check.durationMs,
    executedAt: check.executedAt.toISOString(),
  };
}

function unwrapDomain<T>(result: Result<T, DomainError>): T {
  if (!result.ok) {
    throw new DomainErrorException(result.error.code);
  }
  return result.value;
}

function requireActorId(actor: Actor): string {
  if (actor.accountId === null) {
    throw new ConflictException();
  }
  return actor.accountId;
}
