import {
  isSalesSetupComplete,
  type IntegrationEnvironment,
  type IntegrationRepository,
} from '@sengoku/domain';

/**
 * 決済の設定を、呼び出しのたびに解決する（管理画面・外部連携 指示書 §14）。
 *
 * ⚠️ **起動時に読んだ値を持ち回らない。** 管理画面で鍵や戻り先を変えたら、
 * 次の呼び出しから効いてほしい。持ち回ると「保存できたのに効かない」に
 * なり、しかも効いていないことに気づく手掛かりが無い。
 *
 * ⚠️ **止めたら止まること。** DB 側で無効にしてあるときに環境変数へ
 * 落ちてしまうと、管理画面の「停止」が効かない。事故を止める操作が
 * 効かないのがいちばん困る。
 */

export interface ResolvedPaymentConfig {
  readonly secretKey: string;
  readonly webhookSecret: string;
  readonly apiVersion: string;
  /** `{ORDER_ID}` を注文IDへ置き換えて使う。 */
  readonly successUrlTemplate: string;
  readonly cancelUrlTemplate: string;
  /**
   * プラットフォーム手数料。
   *
   * ⚠️ **0 は「無料」ではなく「販売設定が未完了」。** ここが 0 のまま
   * 支払い口を作らせない判断は、この値を受け取る側で行う。
   */
  readonly platformFeeRateBps: number;
  /** どちらから読んだか。⚠️ 画面とログの説明に使う。値は含めない。 */
  readonly source: 'database' | 'environment';
}

/** 環境変数から読んだ設定（DB に無いときの引き継ぎ元）。 */
export interface EnvPaymentConfig {
  readonly secretKey: string;
  readonly webhookSecret: string;
  readonly apiVersion: string;
  readonly successUrlTemplate: string;
  readonly cancelUrlTemplate: string;
  readonly platformFeeRateBps: number;
}

export type PaymentConfigResolution =
  | { readonly ok: true; readonly config: ResolvedPaymentConfig }
  /** 管理画面から止められている。**環境変数へ落ちない。** */
  | { readonly ok: false; readonly reason: 'disabled' }
  /** 設定か鍵が欠けている。 */
  | { readonly ok: false; readonly reason: 'incomplete' };

export type PaymentConfigResolver = () => Promise<PaymentConfigResolution>;

export interface PaymentConfigResolverOptions {
  /** 保管庫。持たない配備（鍵を DB に置かない運用）では `null`。 */
  readonly integrations: IntegrationRepository | null;
  /** このプロセスの環境。⚠️ 要求から受け取らない。 */
  readonly appEnvironment: IntegrationEnvironment;
  /** DB に設定が入るまでの引き継ぎ元。無ければ `null`。 */
  readonly fallback: EnvPaymentConfig | null;
}

/**
 * 解決の規則（`createWalletDeliveryResolver` と同じ形にそろえてある）。
 *
 * 1. DB に鍵が入っていれば、**DB が正**。
 *    - 止められていれば使わない。環境変数へ落ちない。
 *    - 欠けていれば使わない。半端な設定で支払い口を作ると、
 *      作れたのに入金を確定できない、という最悪の形になる。
 * 2. DB に鍵が入っていなければ、環境変数へ落ちる。
 *    管理画面を開いただけで行はできるので、**行の有無ではなく
 *    鍵の有無**で「引き継いだか」を判定する。
 */
export function createPaymentConfigResolver(
  options: PaymentConfigResolverOptions,
): PaymentConfigResolver {
  return async (): Promise<PaymentConfigResolution> => {
    const integrations = options.integrations;
    const settings =
      integrations === null
        ? null
        : await integrations.findSettings('payment', options.appEnvironment);

    /*
      ⚠️ 「DB を採用したか」は鍵の有無で決める。設定行は画面を開いた
         だけでできるので、行があること自体は何の意味も持たない。
    */
    const secretKey =
      settings === null || integrations === null
        ? null
        : await integrations.revealForAdapter('payment', options.appEnvironment, 'api_key');

    if (secretKey === null) {
      const fallback = options.fallback;
      if (fallback === null) {
        return { ok: false, reason: 'incomplete' };
      }
      return { ok: true, config: { ...fallback, source: 'environment' } };
    }

    // ここから先、`settings` は非 null（鍵は設定行があるときしか引けない）。
    const row = settings as NonNullable<typeof settings>;

    if (!row.enabled) {
      return { ok: false, reason: 'disabled' };
    }

    const webhookSecret = await (integrations as IntegrationRepository).revealForAdapter(
      'payment',
      options.appEnvironment,
      'hmac_secret',
    );
    /*
      ⚠️ 署名鍵が無ければ使わない。支払い口だけ作れて入金を確定できない
         状態は、お金を受け取ったのに注文が進まないという形で表に出る。
    */
    if (webhookSecret === null) {
      return { ok: false, reason: 'incomplete' };
    }
    if (row.payment.checkoutSuccessUrl === null || row.payment.checkoutCancelUrl === null) {
      return { ok: false, reason: 'incomplete' };
    }
    if (!isSalesSetupComplete(row.payment)) {
      return { ok: false, reason: 'incomplete' };
    }

    return {
      ok: true,
      config: {
        secretKey,
        webhookSecret,
        // 空なら実装側の既定に任せる。
        apiVersion: row.payment.apiVersion ?? options.fallback?.apiVersion ?? '',
        successUrlTemplate: row.payment.checkoutSuccessUrl,
        cancelUrlTemplate: row.payment.checkoutCancelUrl,
        platformFeeRateBps: row.payment.platformFeeRateBps,
        source: 'database',
      },
    };
  };
}
