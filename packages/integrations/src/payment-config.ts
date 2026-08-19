import type { IntegrationEnvironment, IntegrationRepository } from '@sengoku/domain';

/**
 * 決済の設定を、呼び出しのたびに解決する。
 *
 * ⚠️ **鍵は DB へ置かない**（2026-08-19 決定）。決済の秘密鍵と Webhook
 * 署名鍵は配備環境の Secret 管理に置き、ここは環境変数からのみ読む。
 * 管理画面から交換できる仕組みは、再認証・二者承認・ローテーション・
 * 復旧経路まで揃えた別仕様として扱う。半端に口だけ開けると、
 * 「画面から鍵を替えられるが、間違えたときに戻せない」状態になる。
 *
 * ⚠️ **管理画面が持つのは、鍵以外の設定と「止める」操作だけ。**
 * 止めたときに環境変数へ落ちてしまうと、管理画面の停止が効かない。
 * 事故を止める操作が効かないのがいちばん困る。
 */

export interface ResolvedPaymentConfig {
  readonly secretKey: string;
  readonly webhookSecret: string;
  readonly apiVersion: string;
  /** `{ORDER_ID}` を注文IDへ置き換えて使う。 */
  readonly successUrlTemplate: string;
  readonly cancelUrlTemplate: string;
  /**
   * 鍵以外の設定を、どちらから読んだか。
   *
   * ⚠️ **鍵の出どころではない。** 鍵は常に配備環境から読む。
   */
  readonly settingsSource: 'database' | 'environment';
}

/** 配備環境（Secret 管理・環境変数）から読んだ決済の設定。 */
export interface EnvPaymentConfig {
  readonly secretKey: string;
  readonly webhookSecret: string;
  readonly apiVersion: string;
  readonly successUrlTemplate: string;
  readonly cancelUrlTemplate: string;
}

export type PaymentConfigResolution =
  | { readonly ok: true; readonly config: ResolvedPaymentConfig }
  /** 管理画面から止められている。**環境変数へ落ちない。** */
  | { readonly ok: false; readonly reason: 'disabled' }
  /** 鍵か設定が欠けている。 */
  | { readonly ok: false; readonly reason: 'incomplete' };

export type PaymentConfigResolver = () => Promise<PaymentConfigResolution>;

export interface PaymentConfigResolverOptions {
  /** 設定の保管庫。持たない配備では `null`。⚠️ 鍵はここから読まない。 */
  readonly integrations: IntegrationRepository | null;
  /** このプロセスの環境。⚠️ 要求から受け取らない。 */
  readonly appEnvironment: IntegrationEnvironment;
  /** 配備環境から読んだ設定。鍵が無ければ `null`。 */
  readonly deployment: EnvPaymentConfig | null;
}

/**
 * 解決の規則。
 *
 * 1. 鍵が配備環境に無ければ、決済できない（`incomplete`）
 * 2. DB に設定行があり、止めてあれば使わない（`disabled`）。
 *    ⚠️ **ここで環境変数へ落ちない。** 落ちると停止が効かない
 * 3. DB に戻り先が入っていれば DB を使い、無ければ配備環境の値を使う
 *
 * ⚠️ **戻り先は鍵ではないので、引き継ぎを許している。** どちらを使ったかは
 * `settingsSource` で分かるようにし、画面にも出す。黙って切り替わるのを
 * 避けるためで、隠すためではない。
 */
export function createPaymentConfigResolver(
  options: PaymentConfigResolverOptions,
): PaymentConfigResolver {
  return async (): Promise<PaymentConfigResolution> => {
    const deployment = options.deployment;
    /*
      ⚠️ 鍵が無ければここで止める。DB を見に行かない。
         「DB に何か入っていれば動くかもしれない」という期待を残さない。
    */
    if (deployment === null || deployment.secretKey === '' || deployment.webhookSecret === '') {
      return { ok: false, reason: 'incomplete' };
    }

    const settings =
      options.integrations === null
        ? null
        : await options.integrations.findSettings('payment', options.appEnvironment);

    if (settings !== null && !settings.enabled) {
      return { ok: false, reason: 'disabled' };
    }

    const fromDatabase =
      settings !== null &&
      settings.payment.checkoutSuccessUrl !== null &&
      settings.payment.checkoutCancelUrl !== null;

    if (!fromDatabase) {
      if (deployment.successUrlTemplate === '' || deployment.cancelUrlTemplate === '') {
        return { ok: false, reason: 'incomplete' };
      }
      return { ok: true, config: { ...deployment, settingsSource: 'environment' } };
    }

    const row = settings as NonNullable<typeof settings>;
    return {
      ok: true,
      config: {
        secretKey: deployment.secretKey,
        webhookSecret: deployment.webhookSecret,
        // 空なら配備環境の版に従う。
        apiVersion: row.payment.apiVersion ?? deployment.apiVersion,
        successUrlTemplate: row.payment.checkoutSuccessUrl ?? '',
        cancelUrlTemplate: row.payment.checkoutCancelUrl ?? '',
        settingsSource: 'database',
      },
    };
  };
}

/**
 * 手数料率だけを引く。
 *
 * ⚠️ **正は DB だけ。環境変数へ落とさない**（2026-08-19 決定）。
 * 落とすと、DB と環境変数で違う値が使われる「二重管理」になる。
 * どちらが効いているかは、金額がずれてから請求で気づくことになる。
 *
 * ⚠️ **資格情報とは別に引く。** 率は決済事業者の設定ではなく販売の条件。
 * 事業者が `fake`（鍵を持たない手元・E2E）でも率は要る。束ねていたせいで、
 * 鍵の無い環境で率が 0 に落ちた。
 *
 * ⚠️ **「連携を止めている」ことは率に影響しない。** 止めるのはお金の
 * 受け口であって、取り分の約束ではない。止めるたびに 0 へ戻すと、
 * 再開したときに手数料が消えていることに気づけない。
 *
 * ⚠️ **未設定なら 0 を返す。既定値を作らない。** 0 は「無料」ではなく
 * 「まだ決めていない」。ここで気を利かせて 20% を入れると、
 * 決めていないまま売れてしまう。0 のときは支払い口を作らせない側が
 * 受け止める。
 *
 * 初期値（2000）は**一度限りのマイグレーション**で DB へ入れてある。
 * 起動のたびに環境変数から読み直す作りにはしない。
 */
export interface PlatformFeeRateReader {
  readPlatformFeeRateBps(environment: IntegrationEnvironment): Promise<number>;
}

export function createPlatformFeeRateResolver(options: {
  /**
   * 率だけを読む口。
   *
   * ⚠️ **設定の保管庫（暗号鍵を要る口）と分けてある。** 率は秘密では
   * ないので、復号の仕組みに依存させない。依存させると、鍵を置いて
   * いない配備で率が 0 に落ちる。
   */
  readonly reader: PlatformFeeRateReader;
  readonly appEnvironment: IntegrationEnvironment;
}): () => Promise<number> {
  return async (): Promise<number> => options.reader.readPlatformFeeRateBps(options.appEnvironment);
}
