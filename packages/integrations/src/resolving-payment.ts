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
 * 署名検証で試す設定を、新しい順に返す口（`UD-128`）。
 *
 * ⚠️ **受付中の世代だけでは足りない。** 切り替えたあとも、旧アカウントで
 * 発生した決済の知らせは届き続ける。新しい世代だけ試すと、旧世代の決済が
 * 「署名が違う」として捨てられ、支払い済みの注文が未払いのまま残る。
 */
export type WebhookVerificationConfigs = () => Promise<readonly ResolvedPaymentConfig[]>;

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

  /**
   * 作ったアダプタの控え。
   *
   * ⚠️ **1 個だけにしない。** 署名検証は世代を順に試すので、1 個だと
   * 検証のたびに入れ替わり、支払い口を作るときに毎回作り直しになる。
   * 決済事業者の SDK は接続を内部に抱えるので、作り直しは接続の張り直し。
   *
   * ⚠️ **上限を設ける。** 際限なく溜めると、鍵を替えるたびに古い接続が
   * 残り続ける。試す世代数（5）＋受付中の 1 個で足りる。
   */
  private readonly cached = new Map<string, PaymentGatewayPort>();

  private static readonly MAX_CACHED_GATEWAYS = 6;

  constructor(
    private readonly resolve: PaymentConfigResolver,
    /** 解決した設定から本物のアダプタを作る。 */
    private readonly build: (config: ResolvedPaymentConfig) => PaymentGatewayPort,
    provider: string,
    /**
     * 署名検証で試す設定（`UD-128`）。
     *
     * ⚠️ 省略すると受付中の世代だけで検証する。旧世代の知らせを
     * 取りこぼすので、世代を運用する配備では必ず渡すこと。
     */
    private readonly verificationConfigs: WebhookVerificationConfigs | null = null,
    /** 検証が通った世代を記録する口。⚠️ 署名の中身は残さない。 */
    private readonly onVerified: ((credentialId: string) => Promise<void>) | null = null,
  ) {
    this.provider = provider;
  }

  async createCheckoutSession(
    input: CreateCheckoutSessionInput,
  ): Promise<Result<CheckoutSessionCreated, DomainError>> {
    const resolved = await this.resolve();
    if (!resolved.ok) {
      return err(reasonToError(resolved.reason));
    }
    const gateway = this.gatewayFor(resolved.config);
    const created = await gateway.createCheckoutSession(input);
    if (!created.ok) {
      return created;
    }
    /*
      ⚠️ **どの世代で作ったかを押す。** ここで作られた識別子は
         発行したアカウントに紐づく。残さないと、あとで返金するときに
         どの鍵で解決すればよいか分からなくなる（`UD-118` §2）。
    */
    return { ok: true, value: { ...created.value, credentialId: resolved.config.credentialId } };
  }

  /**
   * 届いた知らせの署名を確かめる。
   *
   * ⚠️ **世代を新しい順に試す。** 1 つでも通れば成立。全部落ちて初めて
   * 失敗とする。受付中の世代だけで判定すると、切り替え後に届く
   * 旧アカウントの知らせを捨ててしまう。
   *
   * ⚠️ **どの世代で通ったかを返す。** 「まだ旧アカウント宛に決済が
   * 起きている」ことに気づく唯一の手掛かりになる。
   */
  async verifyAndParseWebhook(
    rawBody: Buffer,
    signatureHeader: string,
  ): Promise<Result<ProviderPaymentFact, DomainError>> {
    const candidates = await this.verificationCandidates();
    if (!candidates.ok) {
      return candidates;
    }

    let lastError: DomainError | null = null;
    for (const config of candidates.value) {
      const parsed = await this.gatewayFor(config).verifyAndParseWebhook(rawBody, signatureHeader);
      if (!parsed.ok) {
        lastError = parsed.error;
        continue;
      }
      const { credentialId } = config;
      if (credentialId !== null && this.onVerified !== null) {
        await this.onVerified(credentialId);
      }
      return { ok: true, value: { ...parsed.value, credentialId } };
    }

    /*
      ⚠️ **最後の失敗をそのまま返す。** どの世代で落ちたかは外へ出さない。
         「この署名は世代 3 では通った」と分かると、鍵の当たりを付ける
         手掛かりになる。
    */
    return err(lastError ?? domainError('WEBHOOK_SIGNATURE_INVALID', 'no credential matched'));
  }

  private async verificationCandidates(): Promise<
    Result<readonly ResolvedPaymentConfig[], DomainError>
  > {
    if (this.verificationConfigs !== null) {
      const configs = await this.verificationConfigs();
      if (configs.length > 0) {
        return { ok: true, value: configs };
      }
      /*
        ⚠️ 世代が 1 つも無いときは、受付中の解決に落ちる。落ちた先でも
           世代が無ければ `no_credential` になる。ここで黙って
           配備環境の鍵へ行く経路は作らない。
      */
    }
    const resolved = await this.resolve();
    return resolved.ok
      ? { ok: true, value: [resolved.config] }
      : err(reasonToError(resolved.reason));
  }

  private gatewayFor(config: ResolvedPaymentConfig): PaymentGatewayPort {
    const fingerprint = fingerprintOf(config);
    const hit = this.cached.get(fingerprint);
    if (hit !== undefined) {
      return hit;
    }
    const gateway = this.build(config);
    if (this.cached.size >= ResolvingPaymentGateway.MAX_CACHED_GATEWAYS) {
      // ⚠️ いちばん古い 1 個を落とす。Map は挿入順を保つ。
      const oldest = this.cached.keys().next();
      if (!oldest.done) {
        this.cached.delete(oldest.value);
      }
    }
    this.cached.set(fingerprint, gateway);
    return gateway;
  }

  /** いま効いている設定。画面へ出すのは `source` と手数料率まで。 */
  async currentConfig(): Promise<ResolvedPaymentConfig | null> {
    const resolved = await this.resolve();
    return resolved.ok ? resolved.config : null;
  }
}

/**
 * 解決できなかった理由を、直し方の分かる符号へ移す。
 *
 * ⚠️ **「止めてある」「世代が無い」「設定が足りない」を分ける。** 直し方が
 * 三つとも違う——管理画面で戻す／世代を取り込んで有効化する／設定を埋める。
 * まとめると、止めた本人が「壊れた」と読んで設定を探し始める。
 */
function reasonToError(reason: 'disabled' | 'no_credential' | 'incomplete'): DomainError {
  if (reason === 'disabled') {
    return domainError('PAYMENT_PROVIDER_DISABLED', 'payment integration is disabled');
  }
  if (reason === 'no_credential') {
    return domainError('PAYMENT_CREDENTIAL_CHECK_REQUIRED', 'no accepting credential generation');
  }
  return domainError('SALES_SETUP_INCOMPLETE', 'payment integration is not configured');
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
    config.settingsSource,
    config.apiVersion,
    config.successUrlTemplate,
    config.cancelUrlTemplate,
    // ⚠️ 世代を混ぜる。同じ鍵でも別世代なら別のアダプタとして扱う。
    config.credentialId ?? 'deployment',
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
