import {
  acceptingGeneration,
  type IntegrationEnvironment,
  type IntegrationRepository,
  type OpenedPaymentCredential,
  type PaymentCredentialGeneration,
} from '@sengoku/domain';

/**
 * 決済の設定を、呼び出しのたびに解決する。
 *
 * ⚠️ **鍵は世代の表から読む**（`UD-128`。2026-08-20 切り替え）。
 * 以前は配備環境の環境変数だけを見ていた。世代の表（`UD-118`）が
 * 入ったので、**受付中の世代**の鍵を使う。こうしないと、管理画面で
 * 「有効」と表示されているのに実際には環境変数の鍵が使われている、
 * という食い違いが残り続ける。
 *
 * ⚠️ **世代が無いときに環境変数へ黙って落ちない。** 落ちると、
 * DB と環境変数で違う鍵が使われる「二重管理」になる。どちらが効いて
 * いるかは、入金先がずれてから気づくことになる。落ちるのは
 * `PAYMENT_EMERGENCY_CREDENTIAL_OVERRIDE` を**明示的に**立てたときだけで、
 * そのときは起動のたびに警告を出す。
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
   * ⚠️ **鍵の出どころではない。** 鍵の出どころは `keySource`。
   */
  readonly settingsSource: 'database' | 'environment';
  /**
   * 鍵をどこから読んだか（`UD-128`）。
   *
   * ⚠️ **`deployment` は緊急上書き中だけ。** 通常は必ず `generation`。
   * 画面とログに出して、二重管理が黙って復活していないか見えるようにする。
   */
  readonly keySource: 'generation' | 'deployment';
  /** 使った世代。⚠️ 緊急上書き中と `fake` では `null`。 */
  readonly credentialId: string | null;
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
  /**
   * 使える世代が無い（`UD-128`）。
   *
   * ⚠️ **`incomplete` と分けてある。** 直し方が違う。設定が足りないなら
   * 埋める、世代が無いなら**取り込んで有効化する**
   * （`pnpm payment:credential -- --import` → `--activate`）。
   * まとめると、鍵を入れたのに動かない人が設定の方を探し始める。
   */
  | { readonly ok: false; readonly reason: 'no_credential' }
  /** 鍵以外の設定が欠けている。 */
  | { readonly ok: false; readonly reason: 'incomplete' };

/**
 * 世代を引く口。
 *
 * ⚠️ **`open` は復号を伴う。** 呼んでよいのは決済の実行経路だけで、
 * 画面向けの経路からは呼ばない（`PaymentCredentialRepository` の注記）。
 */
export interface PaymentCredentialSource {
  list(
    provider: string,
    environment: IntegrationEnvironment,
  ): Promise<readonly PaymentCredentialGeneration[]>;
  open(id: string): Promise<OpenedPaymentCredential | null>;
  openForVerification(
    provider: string,
    environment: IntegrationEnvironment,
    limit: number,
  ): Promise<readonly OpenedPaymentCredential[]>;
}

export type PaymentConfigResolver = () => Promise<PaymentConfigResolution>;

export interface PaymentConfigResolverOptions {
  /** 設定の保管庫。持たない配備では `null`。⚠️ 鍵はここから読まない。 */
  readonly integrations: IntegrationRepository | null;
  /** このプロセスの環境。⚠️ 要求から受け取らない。 */
  readonly appEnvironment: IntegrationEnvironment;
  /**
   * 配備環境から読んだ設定。
   *
   * ⚠️ **鍵は緊急上書き中しか使わない**（`UD-128`）。戻り先と API 版は
   * 鍵ではないので、世代に入っていなければこちらを引き継ぎ元にする。
   */
  readonly deployment: EnvPaymentConfig | null;
  /** 決済事業者。世代を引くときの鍵になる。 */
  readonly provider: string;
  /** 世代の表。持たない配備（暗号鍵なし）では `null`。 */
  readonly credentials: PaymentCredentialSource | null;
  /**
   * 緊急上書き（`PAYMENT_EMERGENCY_CREDENTIAL_OVERRIDE`）。
   *
   * ⚠️ **既定は `false`。** 立てると配備環境の鍵を直接使う。
   * 世代の表を壊してしまった場合の復旧経路であって、常用しない。
   * 立っているあいだは起動のたびに警告を出す（`main.ts`）。
   */
  readonly emergencyOverride: boolean;
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
    /*
      ⚠️ **「止めてある」を最初に見る。** 鍵や世代より先に判定しないと、
         止めたのに「設定が足りない」と表示されて、止めた本人が
         設定を探し始める。
    */
    const settings =
      options.integrations === null
        ? null
        : await options.integrations.findSettings('payment', options.appEnvironment);

    if (settings !== null && !settings.enabled) {
      return { ok: false, reason: 'disabled' };
    }

    const keys = await resolveKeys(options);
    if (!keys.ok) {
      return keys;
    }
    /*
      戻り先と API 版の引き継ぎ元。⚠️ **鍵ではない**ので、世代に無ければ
      配備環境の値を使ってよい。どちらを使ったかは `settingsSource` で分かる。
    */
    const deployment: EnvPaymentConfig = {
      secretKey: keys.secretKey,
      webhookSecret: keys.webhookSecret,
      apiVersion: keys.apiVersion ?? options.deployment?.apiVersion ?? '',
      successUrlTemplate: options.deployment?.successUrlTemplate ?? '',
      cancelUrlTemplate: options.deployment?.cancelUrlTemplate ?? '',
    };
    const stamp = { keySource: keys.keySource, credentialId: keys.credentialId } as const;

    const fromDatabase =
      settings !== null &&
      settings.payment.checkoutSuccessUrl !== null &&
      settings.payment.checkoutCancelUrl !== null;

    if (!fromDatabase) {
      if (deployment.successUrlTemplate === '' || deployment.cancelUrlTemplate === '') {
        return { ok: false, reason: 'incomplete' };
      }
      return { ok: true, config: { ...deployment, settingsSource: 'environment', ...stamp } };
    }

    const row = settings as NonNullable<typeof settings>;
    return {
      ok: true,
      config: {
        secretKey: deployment.secretKey,
        webhookSecret: deployment.webhookSecret,
        // 空なら世代／配備環境の版に従う。
        apiVersion: row.payment.apiVersion ?? deployment.apiVersion,
        successUrlTemplate: row.payment.checkoutSuccessUrl ?? '',
        cancelUrlTemplate: row.payment.checkoutCancelUrl ?? '',
        settingsSource: 'database',
        ...stamp,
      },
    };
  };
}

type KeyResolution =
  | {
      readonly ok: true;
      readonly secretKey: string;
      readonly webhookSecret: string;
      readonly apiVersion: string | null;
      readonly keySource: 'generation' | 'deployment';
      readonly credentialId: string | null;
    }
  | { readonly ok: false; readonly reason: 'no_credential' | 'incomplete' };

/**
 * 鍵をどこから読むか（`UD-128` の中心）。
 *
 * 順序に意味がある:
 *   1. 緊急上書きが立っていれば配備環境の鍵。⚠️ **明示のときだけ**
 *   2. 受付中の世代があればその鍵
 *   3. 無ければ止める。⚠️ **配備環境へ黙って落ちない**
 *
 * ⚠️ **3 を「配備環境の鍵があるなら使う」にしない。** 世代を有効化した
 * つもりで環境変数の古い鍵が使われ続ける、という食い違いが起きる。
 * 入金先がずれてから気づくことになり、そのときには売上が別の口座にある。
 */
async function resolveKeys(options: PaymentConfigResolverOptions): Promise<KeyResolution> {
  const deployment = options.deployment;

  if (options.emergencyOverride) {
    if (deployment === null || deployment.secretKey === '' || deployment.webhookSecret === '') {
      return { ok: false, reason: 'incomplete' };
    }
    return {
      ok: true,
      secretKey: deployment.secretKey,
      webhookSecret: deployment.webhookSecret,
      apiVersion: deployment.apiVersion === '' ? null : deployment.apiVersion,
      keySource: 'deployment',
      // ⚠️ 世代を通していないので `null`。あとで「どの鍵か」は追えない。
      //    緊急上書きを常用してはいけない理由がこれ。
      credentialId: null,
    };
  }

  if (options.credentials === null) {
    return { ok: false, reason: 'no_credential' };
  }

  const generations = await options.credentials.list(options.provider, options.appEnvironment);
  const accepting = acceptingGeneration(generations);
  if (accepting === null) {
    // 0 件でも 2 件でもここへ来る。⚠️ 2 件のときに「たまたま先頭」を
    //    選ばないのが肝（`acceptingGeneration` の注記）。
    return { ok: false, reason: 'no_credential' };
  }

  const opened = await options.credentials.open(accepting.id);
  if (opened === null) {
    // 行はあるが復号できない（鍵の版が合わない等）。⚠️ ここも落とさない。
    return { ok: false, reason: 'no_credential' };
  }

  return {
    ok: true,
    secretKey: opened.secretKey,
    webhookSecret: opened.webhookSecret,
    apiVersion: opened.apiVersion,
    keySource: 'generation',
    credentialId: opened.id,
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
