import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  ActivatePaymentCredentialRequest,
  PaymentCredentialListResponse,
  PaymentCredentialView,
  RegisterPaymentCredentialRequest,
} from '@sengoku/contracts';
import type { Actor } from '@sengoku/auth';
import {
  CREDENTIAL_VERIFICATION_LIMIT,
  acceptingGeneration,
  activateGeneration,
  canAcceptPayments,
  isErr,
  retireGeneration,
  verificationOrder,
  type AuditLogPort,
  type ClockPort,
  type IntegrationEnvironment,
  type PaymentCredentialGeneration,
  type PaymentCredentialRepository,
  type SecretCipherPort,
} from '@sengoku/domain';
import { DomainErrorException } from '../common/domain-error.filter';

export interface PaymentCredentialConfig {
  readonly provider: string;
  readonly appEnvironment: IntegrationEnvironment;
  /** 緊急上書きが有効か。⚠️ 既定は無効。 */
  readonly emergencyOverrideActive: boolean;
  /** 世代ごとの決済件数。⚠️ 件数だけ。金額は出さない。 */
  readonly countPayments: (credentialId: string) => Promise<number>;
  /**
   * 新しい鍵で決済事業者へ問い合わせ、アカウント識別子を得る。
   *
   * ⚠️ **業務データを送らない。** アカウントを読むだけの呼び出しにする。
   * ⚠️ 失敗の詳細（例外の本文）を返さない。鍵が混ざりうる。
   */
  readonly probeAccount: (
    secretKey: string,
    apiVersion: string | null,
  ) => Promise<{ readonly ok: true; readonly accountRef: string } | { readonly ok: false }>;
}

/**
 * 決済資格情報の世代（`UD-118`）。
 *
 * ⚠️ **鍵をこの層から出さない。** 受け取るのは登録のときだけで、封をして
 * 保管庫へ渡したあとは持たない。応答にも監査ログにも載せない。
 *
 * ⚠️ **判断はドメインが持つ。** 「接続確認を通らないと有効化できない」
 * 「旧世代は退役させない」をここへ書き足さない。2 か所に散ると必ずずれる。
 */
@Injectable()
export class PaymentCredentialService {
  constructor(
    private readonly credentials: PaymentCredentialRepository,
    private readonly cipher: SecretCipherPort,
    private readonly clock: ClockPort,
    private readonly audit: AuditLogPort,
    private readonly config: PaymentCredentialConfig,
  ) {}

  async list(): Promise<PaymentCredentialListResponse> {
    const generations = await this.credentials.list(
      this.config.provider,
      this.config.appEnvironment,
    );
    const verifiable = new Set(
      verificationOrder(generations, CREDENTIAL_VERIFICATION_LIMIT).map((row) => row.id),
    );

    const views: PaymentCredentialView[] = [];
    for (const row of generations) {
      views.push({
        ...toView(row),
        paymentCount: await this.config.countPayments(row.id),
        verifiable: verifiable.has(row.id),
      });
    }

    return {
      environment: this.config.appEnvironment,
      provider: this.config.provider,
      generations: views,
      canAcceptPayments: canAcceptPayments(generations),
      emergencyOverrideActive: this.config.emergencyOverrideActive,
    };
  }

  async register(
    actor: Actor,
    request: RegisterPaymentCredentialRequest,
  ): Promise<PaymentCredentialListResponse> {
    const accountId = requireAccount(actor);
    const scope = { service: 'payment' as const, environment: this.config.appEnvironment };

    const registered = await this.credentials.register({
      provider: this.config.provider,
      environment: this.config.appEnvironment,
      label: request.label ?? null,
      apiVersion: request.apiVersion ?? null,
      // ⚠️ 平文はここで封をして、以後どこにも残さない。
      secretKey: this.cipher.seal(request.secretKey, scope),
      webhookSecret: this.cipher.seal(request.webhookSecret, scope),
      registeredByAccountId: accountId,
    });

    await this.audit.record({
      actorAccountId: accountId,
      action: 'payment_credential.registered',
      targetType: 'payment_credential',
      targetId: registered.id,
      // ⚠️ 鍵そのもの・先頭・末尾を残さない。
      summary: { generation: registered.generation, environment: this.config.appEnvironment },
    });

    return this.list();
  }

  /**
   * 接続確認。
   *
   * ⚠️ **ここで初めて「別のアカウントかどうか」が確定する。** 鍵の
   * 打ち間違いもここで止まる。二者承認をやめた代わりの守りなので、
   * 有効化の前に必ず通す。
   */
  async check(actor: Actor, id: string): Promise<PaymentCredentialListResponse> {
    const accountId = requireAccount(actor);
    const opened = await this.credentials.open(id);
    if (opened === null) {
      throw new NotFoundException();
    }

    const probe = await this.config.probeAccount(opened.secretKey, opened.apiVersion);
    const recorded = await this.credentials.recordCheck({
      id,
      succeeded: probe.ok,
      accountRef: probe.ok ? probe.accountRef : null,
      checkedAt: this.clock.now(),
    });
    if (recorded === null) {
      throw new NotFoundException();
    }

    await this.audit.record({
      actorAccountId: accountId,
      action: 'payment_credential.checked',
      targetType: 'payment_credential',
      targetId: id,
      summary: {
        generation: recorded.generation,
        succeeded: probe.ok,
        // ⚠️ アカウント識別子は秘密ではない。むしろ残す価値がある。
        accountRef: probe.ok ? probe.accountRef : null,
      },
    });

    return this.list();
  }

  async activate(
    actor: Actor,
    id: string,
    request: ActivatePaymentCredentialRequest,
  ): Promise<PaymentCredentialListResponse> {
    const accountId = requireAccount(actor);
    this.requireConfirmation(request.confirmation ?? null);

    const generations = await this.credentials.list(
      this.config.provider,
      this.config.appEnvironment,
    );
    const target = generations.find((row) => row.id === id);
    if (target === undefined) {
      throw new NotFoundException();
    }

    const decided = activateGeneration({
      target,
      currentlyAccepting: acceptingGeneration(generations),
      now: this.clock.now(),
    });
    if (isErr(decided)) {
      throw new DomainErrorException(decided.error.code);
    }

    const activated = await this.credentials.activate({
      id,
      steppedDownId: decided.value.steppedDown?.id ?? null,
      activatedByAccountId: accountId,
      activatedAt: this.clock.now(),
    });
    if (activated === null) {
      // 途中で受付世代が変わっていた。読み込み直してもらう。
      throw new DomainErrorException('PAYMENT_CREDENTIAL_NOT_ACTIVATABLE');
    }

    await this.audit.record({
      actorAccountId: accountId,
      action: 'payment_credential.activated',
      targetType: 'payment_credential',
      targetId: id,
      summary: {
        generation: activated.generation,
        accountRef: activated.accountRef,
        steppedDownGeneration: decided.value.steppedDown?.generation ?? null,
      },
    });

    return this.list();
  }

  /**
   * 新規受付だけを止める・戻す。
   *
   * ⚠️ **切り戻しの経路でもある。** 有効化の直後に問題が分かったら、
   * 旧世代を受付へ戻すだけで元に戻る。
   */
  async setAccepting(
    actor: Actor,
    id: string,
    accepts: boolean,
    confirmation: string | null,
  ): Promise<PaymentCredentialListResponse> {
    const accountId = requireAccount(actor);
    this.requireConfirmation(confirmation);

    const updated = await this.credentials.setAcceptsNewPayments(id, accepts);
    if (updated === null) {
      throw new DomainErrorException('PAYMENT_CREDENTIAL_NOT_ACTIVATABLE');
    }

    await this.audit.record({
      actorAccountId: accountId,
      action: accepts ? 'payment_credential.accepting_on' : 'payment_credential.accepting_off',
      targetType: 'payment_credential',
      targetId: id,
      summary: { generation: updated.generation },
    });

    return this.list();
  }

  async retire(
    actor: Actor,
    id: string,
    confirmation: string | null,
  ): Promise<PaymentCredentialListResponse> {
    const accountId = requireAccount(actor);
    this.requireConfirmation(confirmation);

    const target = await this.credentials.findById(id);
    if (target === null) {
      throw new NotFoundException();
    }
    const decided = retireGeneration(target, this.clock.now());
    if (isErr(decided)) {
      throw new DomainErrorException(decided.error.code);
    }

    const retired = await this.credentials.retire(id, this.clock.now());
    if (retired === null) {
      throw new DomainErrorException('PAYMENT_CREDENTIAL_IN_USE');
    }

    await this.audit.record({
      actorAccountId: accountId,
      action: 'payment_credential.retired',
      targetType: 'payment_credential',
      targetId: id,
      summary: { generation: retired.generation },
    });

    return this.list();
  }

  /**
   * 本番での操作には、環境名の入力を求める。
   *
   * ⚠️ **「本当によろしいですか」の一段だけにしない。** 押し慣れると
   * 意味を失う。手を止めさせるには、打たせるのがいちばん確実。
   */
  private requireConfirmation(confirmation: string | null): void {
    if (this.config.appEnvironment !== 'production') {
      return;
    }
    if (confirmation !== 'production') {
      throw new BadRequestException({
        error: {
          code: 'CONFIRMATION_REQUIRED',
          message: '本番の設定です。確認のため「production」と入力してください。',
        },
      });
    }
  }
}

function requireAccount(actor: Actor): string {
  if (actor.accountId === null) {
    throw new NotFoundException();
  }
  return actor.accountId;
}

function toView(
  row: PaymentCredentialGeneration,
): Omit<PaymentCredentialView, 'paymentCount' | 'verifiable'> {
  return {
    id: row.id,
    generation: row.generation,
    status: row.status,
    accountRef: row.accountRef,
    label: row.label,
    apiVersion: row.apiVersion,
    acceptsNewPayments: row.acceptsNewPayments,
    lastCheckSucceeded: row.lastCheckSucceeded,
    lastCheckAt: row.lastCheckAt?.toISOString() ?? null,
    lastWebhookReceivedAt: row.lastWebhookReceivedAt?.toISOString() ?? null,
    activatedAt: row.activatedAt?.toISOString() ?? null,
    retiredAt: row.retiredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
