import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  ConnectionCheckView,
  IntegrationListResponse,
  IntegrationStatusView,
  RegisterSecretRequest,
  UpdateIntegrationRequest,
} from '@sengoku/contracts';
import type { Actor } from '@sengoku/auth';
import {
  CHECK_FRESHNESS_MS,
  INTEGRATION_SERVICES,
  canRunCheck,
  classifyProbe,
  isManagedFromAdmin,
  activateSecret,
  disableIntegration,
  discardPendingSecret,
  enableIntegration,
  isCheckFresh,
  updatePaymentSettings,
  updateSettings,
  validateSecretKeyForEnvironment,
  validateWebhookSecret,
  isSalesSetupComplete,
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
  type ConnectionCheckKind,
  type EnvIntegrationSummary,
  type ProbeOutcome,
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
    /**
     * 接続先へ届くかどうかを確かめる手段。
     *
     * ⚠️ **ここに「どうやって確かめるか」を書かない。** 相手ごとに
     * 安全な確かめ方が違う。いまは本文を持たない `OPTIONS` だけで、
     * それ以上を送ってよいかは要決定 06 のまま。
     */
    private readonly probe: (
      endpointUrl: string,
      timeoutMs: number,
    ) => Promise<{ readonly outcome: ProbeOutcome; readonly durationMs: number }>,
    /**
     * 配備環境から読める姿を返す。
     *
     * ⚠️ **値を返させない。** 返すのは方式と、欠けている設定の名前まで。
     * ここが値を返す形になった瞬間、秘密が API の応答へ届く道ができる。
     */
    private readonly describeEnvironment: (service: IntegrationService) => EnvIntegrationSummary,
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
    /*
      ⚠️ **管理外の連携では DB の行を作らない。** 作ると、誰も読まない
         設定が「保存できる場所」として残る。読まれない値を持てる場所は、
         いつか誰かが埋めて、効かないことに悩む。
    */
    if (!isManagedFromAdmin(service)) {
      return this.environmentStatus(service, environment);
    }

    const settings = await this.repository.ensureSettings(
      this.ids.generate(),
      service,
      environment,
    );
    const [secrets, lastCheck, recentChecks] = await Promise.all([
      this.repository.listSecrets(service, environment),
      this.repository.findLatestConnectionCheck(service, environment),
      // ⚠️ 成功だけを残さない。失敗も並べないと、
      //    「何度も失敗したあとの 1 回の成功」が見えなくなる。
      this.repository.listConnectionChecks(service, environment, RECENT_CHECK_LIMIT),
    ]);

    const now = this.clock.now();
    const fresh = isCheckFresh(lastCheck, CHECK_FRESHNESS_MS, now);
    /*
      ⚠️ **有効化できるかの判定は、ドメインの関数をそのまま使う。**
         画面用に別式を書くと、「画面では押せるのに保存で断られる」
         あるいはその逆が、いつか必ず生まれる。
    */
    const canEnable = enableIntegration({
      settings,
      activeSecretPurposes: secrets
        .filter((secret) => secret.status === 'active')
        .map((secret) => secret.purpose),
      lastCheck,
      freshnessMs: CHECK_FRESHNESS_MS,
      now,
    }).ok;

    return {
      service,
      environment,
      endpointUrl: settings.endpointUrl,
      keyId: settings.keyId,
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
      canEnable,
      canCheck: canRunCheck(settings),
      manageable: true,
      // ⚠️ 管理できる連携では、正は DB。2 つの正を並べない。
      environmentSummary: null,
      recentChecks: recentChecks.map(toCheckView),
      payment:
        service === 'payment'
          ? {
              ...settings.payment,
              // ⚠️ 0 を「手数料無料」と読ませないための印。
              salesSetupComplete: isSalesSetupComplete(settings.payment),
            }
          : null,
    };
  }

  /**
   * 管理外の連携（画像の保管先・ログイン）の姿。
   *
   * ⚠️ **DB ではなく配備環境が正。** これらは起動時に環境変数から
   * 読んで組み立てる。DB に値を置いても効かないので、置かない。
   *
   * ⚠️ **それでも「見る」ことはできるようにする。** 見えないと、
   * 設定が欠けていることに配備してから気づくことになる。
   */
  private async environmentStatus(
    service: IntegrationService,
    environment: IntegrationEnvironment,
  ): Promise<IntegrationStatusView> {
    const summary = this.describeEnvironment(service);
    const [lastCheck, recentChecks] = await Promise.all([
      this.repository.findLatestConnectionCheck(service, environment),
      this.repository.listConnectionChecks(service, environment, RECENT_CHECK_LIMIT),
    ]);

    return {
      service,
      environment,
      // 到達性を確かめられる公開 URL。⚠️ 資格情報を含む URL は入らない。
      endpointUrl: summary.publicUrl,
      keyId: null,
      apiVersion: null,
      timeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
      maxAttempts: 0,
      // ⚠️ 「有効か」は配備環境が決める。画面から切り替えられない。
      enabled: summary.complete,
      rowVersion: 0,
      // ⚠️ 資格情報は配備環境の Secret にある。ここには出てこない。
      secrets: [],
      lastCheck: lastCheck === null ? null : toCheckView(lastCheck),
      checkFresh: isCheckFresh(lastCheck, CHECK_FRESHNESS_MS, this.clock.now()),
      canEnable: false,
      canCheck: summary.publicUrl !== null,
      manageable: false,
      environmentSummary: { ...summary, missing: [...summary.missing] },
      recentChecks: recentChecks.map(toCheckView),
      // 決済は管理できる連携なので、ここへは来ない。
      payment: null,
    };
  }

  /**
   * 設定を書き換える。
   *
   * ⚠️ **接続先を変えたら、それまでの接続テストの成功を無効にする。**
   * 別の相手に対する成功なので、そのまま有効化を許すと
   * 「テスト済み」の顔をした未確認の接続先が本番に載る。
   */
  /**
   * 接続先へ届くかどうかを確かめる（指示書 §4.3・要決定 06）。
   *
   * ⚠️ **業務データを送らない。** 送るのは本文を持たない `OPTIONS` だけ。
   * 相手は受取権を作る口で、試し打ちしてよい相手ではない。
   *
   * ⚠️ **この確認で分かるのは到達性まで。** 資格情報が正しいかどうかは
   * 確かめていない。応答にもその区別（`kind`）を載せる。
   */
  async runCheck(
    actor: Actor,
    service: IntegrationService,
    environment: IntegrationEnvironment,
  ): Promise<IntegrationStatusView> {
    const actorId = requireActorId(actor);

    /*
      管理外の連携でも、届くかどうかは確かめられる。
      ⚠️ 確かめるのは**公開 URL**だけ（画像の配信元・鍵束の置き場）。
         どちらもブラウザから見えるもので、資格情報を含まない。
    */
    const target = isManagedFromAdmin(service)
      ? await this.repository
          .ensureSettings(this.ids.generate(), service, environment)
          .then((settings) => ({
            endpointUrl: settings.endpointUrl,
            timeoutMs: settings.timeoutMs,
          }))
      : {
          endpointUrl: this.describeEnvironment(service).publicUrl,
          timeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
        };

    const settings = target;
    if (!canRunCheck(settings)) {
      // ⚠️ 「試したが失敗した」と「接続先を入れていない」を混ぜない。
      //    直し方がまったく違う。
      throw new DomainErrorException('INTEGRATION_SETTINGS_INVALID');
    }

    const probe = await this.probe(settings.endpointUrl ?? '', settings.timeoutMs);
    const verdict = classifyProbe(probe.outcome);

    await this.recordCheck({
      service,
      environment,
      kind: 'reachability',
      succeeded: verdict.succeeded,
      failureCode: verdict.failureCode,
      httpStatus: verdict.httpStatus,
      durationMs: probe.durationMs,
      // ⚠️ この確認は資格情報を使っていない。使ったことにしない。
      secretId: null,
      actorAccountId: actorId,
      correlationId: null,
    });

    return this.status(service, environment);
  }

  async update(
    actor: Actor,
    service: IntegrationService,
    environment: IntegrationEnvironment,
    request: UpdateIntegrationRequest,
  ): Promise<IntegrationStatusView> {
    const actorId = requireActorId(actor);
    /*
      ⚠️ **管理外の連携は、そもそも受け付けない。** 画面で隠すだけにすると、
         直接叩けば「誰も読まない設定」が保存できてしまう。
         保存できたのに効かない、は理由を誰も説明できない状態を作る。
    */
    this.requireManaged(service);

    const settings = await this.repository.ensureSettings(
      this.ids.generate(),
      service,
      environment,
    );

    const updated = unwrapDomain(
      updateSettings(settings, {
        endpointUrl: request.endpointUrl,
        keyId: request.keyId,
        apiVersion: request.apiVersion,
        timeoutMs: request.timeoutMs,
        maxAttempts: request.maxAttempts,
      }),
    );

    /*
      決済に固有の欄。
      ⚠️ **ほかの連携へ送られても書き換えない。** 意味の無い欄が
         黙って保存されると、あとから読んだ人が「効くのか」を
         判断できなくなる。
    */
    const withPayment =
      service === 'payment'
        ? {
            ...updated,
            settings: {
              ...updated.settings,
              payment: unwrapDomain(
                updatePaymentSettings(updated.settings.payment, {
                  apiVersion: request.apiVersion,
                  checkoutSuccessUrl: request.checkoutSuccessUrl,
                  checkoutCancelUrl: request.checkoutCancelUrl,
                  platformFeeRateBps: request.platformFeeRateBps,
                }),
              ),
            },
          }
        : updated;

    const saved = await this.repository.saveSettings(
      withPayment.settings,
      request.rowVersion,
      actorId,
    );
    if (saved === null) {
      // 読んでから書くまでに、ほかの人が変えていた。
      throw new DomainErrorException('INTEGRATION_SETTINGS_CONFLICT');
    }

    if (withPayment.endpointChanged) {
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
    this.requireManaged(service);

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
          activeSecretPurposes: secrets
            .filter((secret) => secret.status === 'active')
            .map((secret) => secret.purpose),
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
    this.requireManaged(service);

    /*
      ⚠️ **決済の鍵は保存の時点で確かめる。** 起動時の検査だけに任せると、
         取り違えた鍵が DB に入り、次の再起動まで気づけない。しかも
         気づく形が「入金が無い」か「本物のお金が動いた」のどちらか。
    */
    if (service === 'payment') {
      const verdict =
        request.purpose === 'api_key'
          ? validateSecretKeyForEnvironment(request.value, environment)
          : validateWebhookSecret(request.value);
      if (!verdict.ok) {
        throw new DomainErrorException(verdict.error.code);
      }
    }

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
    readonly kind: ConnectionCheckKind;
    readonly succeeded: boolean;
    readonly failureCode: string | null;
    readonly httpStatus: number | null;
    readonly durationMs: number;
    readonly secretId: string | null;
    readonly actorAccountId: string;
    readonly correlationId: string | null;
  }): Promise<ConnectionCheckRecord> {
    const record: ConnectionCheckRecord = {
      id: this.ids.generate(),
      service: input.service,
      environment: input.environment,
      kind: input.kind,
      succeeded: input.succeeded,
      failureCode: input.failureCode,
      httpStatus: input.httpStatus,
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
        kind: input.kind,
        succeeded: input.succeeded,
        failureCode: input.failureCode,
        httpStatus: input.httpStatus,
      },
    });
    return record;
  }

  /**
   * 管理画面から変えてよい連携か。
   *
   * ⚠️ **変えられない理由は `isManagedFromAdmin` のコメントにある。**
   * ここに書き写さない。2 か所に書くと、片方だけ直されて食い違う。
   */
  private requireManaged(service: IntegrationService): void {
    if (!isManagedFromAdmin(service)) {
      throw new DomainErrorException('INTEGRATION_NOT_MANAGED');
    }
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

function toCheckView(check: ConnectionCheckRecord): ConnectionCheckView {
  return {
    id: check.id,
    kind: check.kind,
    succeeded: check.succeeded,
    failureCode: check.failureCode,
    httpStatus: check.httpStatus,
    durationMs: check.durationMs,
    executedAt: check.executedAt.toISOString(),
  };
}

/** 画面に並べる履歴の件数。多くしても読まれない。 */
const RECENT_CHECK_LIMIT = 10;

/**
 * 管理外の連携を確かめるときの待ち上限。
 *
 * ⚠️ **短くしておく。** 人が押して待つ操作なので、長いと画面が止まる。
 */
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

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
