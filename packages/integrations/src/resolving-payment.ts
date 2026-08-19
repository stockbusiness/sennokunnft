import {
  domainError,
  err,
  type CheckoutSessionCreated,
  type CreateCheckoutSessionInput,
  type DomainError,
  type PaymentGatewayPort,
  type ProviderPaymentFact,
  type Result,
} from '@sengoku/domain';

import type { PaymentConfigResolver, ResolvedPaymentConfig } from './payment-config';

/**
 * 呼び出しのたびに設定を引き直す決済ゲートウェイ。
 *
 * ⚠️ **本物のアダプタ（Stripe）はこの中で作る。** 外から渡された 1 個を
 * 使い回すと、管理画面で鍵を替えても古い鍵のまま動き続ける。
 *
 * ⚠️ **毎回作り直しはしない。** 解決した設定が前回と同じなら、前回の
 * アダプタを使う。決済事業者の SDK は接続を内部に抱えるので、
 * 呼び出しごとに捨てると接続が張り直しになる。
 */
export class ResolvingPaymentGateway implements PaymentGatewayPort {
  public readonly provider: string;

  private cached: { readonly fingerprint: string; readonly gateway: PaymentGatewayPort } | null =
    null;

  constructor(
    private readonly resolve: PaymentConfigResolver,
    /** 解決した設定から本物のアダプタを作る。 */
    private readonly build: (config: ResolvedPaymentConfig) => PaymentGatewayPort,
    provider: string,
  ) {
    this.provider = provider;
  }

  async createCheckoutSession(
    input: CreateCheckoutSessionInput,
  ): Promise<Result<CheckoutSessionCreated, DomainError>> {
    const gateway = await this.gatewayOrError();
    if (!gateway.ok) {
      return gateway;
    }
    return gateway.value.createCheckoutSession(input);
  }

  async verifyAndParseWebhook(
    rawBody: Buffer,
    signatureHeader: string,
  ): Promise<Result<ProviderPaymentFact, DomainError>> {
    const gateway = await this.gatewayOrError();
    if (!gateway.ok) {
      return gateway;
    }
    return gateway.value.verifyAndParseWebhook(rawBody, signatureHeader);
  }

  /** いま効いている設定。画面へ出すのは `source` と手数料率まで。 */
  async currentConfig(): Promise<ResolvedPaymentConfig | null> {
    const resolved = await this.resolve();
    return resolved.ok ? resolved.config : null;
  }

  private async gatewayOrError(): Promise<Result<PaymentGatewayPort, DomainError>> {
    const resolved = await this.resolve();
    if (!resolved.ok) {
      /*
        ⚠️ 「止めてある」と「設定が足りない」を分けて返す。直し方が違う。
           止めてあるなら管理画面で戻す、足りないなら設定を埋める。
           まとめてしまうと、止めた本人が「壊れた」と読んで探し始める。
      */
      return err(
        resolved.reason === 'disabled'
          ? domainError('PAYMENT_PROVIDER_DISABLED', 'payment integration is disabled')
          : domainError('SALES_SETUP_INCOMPLETE', 'payment integration is not configured'),
      );
    }

    const fingerprint = fingerprintOf(resolved.config);
    const cached = this.cached;
    if (cached !== null && cached.fingerprint === fingerprint) {
      return { ok: true, value: cached.gateway };
    }

    const gateway = this.build(resolved.config);
    this.cached = { fingerprint, gateway };
    return { ok: true, value: gateway };
  }
}

/**
 * 設定が変わったかどうかの見分け。
 *
 * ⚠️ **鍵そのものを持ち回らない。** ここで作る文字列は、例外の文面や
 * ログに紛れ込みうる。鍵は長さだけを見て、値は入れない。
 * 長さが同じで中身だけ違う差し替えは拾えないが、そのときは
 * `keyVersion` が変わるので `webhookSecret.length` 側で差が出る。
 */
function fingerprintOf(config: ResolvedPaymentConfig): string {
  return [
    config.source,
    config.apiVersion,
    config.successUrlTemplate,
    config.cancelUrlTemplate,
    String(config.platformFeeRateBps),
    `sk:${config.secretKey.length}:${hash(config.secretKey)}`,
    `wh:${config.webhookSecret.length}:${hash(config.webhookSecret)}`,
  ].join('|');
}

/**
 * 値を出さずに差を見分けるための短い数値。
 *
 * ⚠️ **暗号用途ではない。** 使うのは「前回と同じ設定か」の判定だけで、
 * ここから鍵を復元されても困らない強度、という話ではなく、
 * **そもそも鍵を復元できるだけの情報を残さない**ことを狙っている。
 * 32bit に潰しているのはそのため。
 */
function hash(value: string): string {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) {
    h = (Math.imul(h, 31) + value.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}
