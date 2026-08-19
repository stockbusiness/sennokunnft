import { err, ok, type Result } from '../shared/result';
import { domainError, type DomainError } from '../shared/errors';
import type { IntegrationEnvironment } from './service';

/**
 * 決済連携の設定（管理画面から変える分）。
 *
 * ⚠️ **ここは「お金の入口」の設定。** ほかの連携と違い、間違えると
 * 「決済は通るのに入金されない」「試験のつもりで本物のお金が動く」
 * のどちらかが起きる。どちらも、起きてから気づく類の事故になる。
 * そのため、起動時と**同じ検査を保存の時点でも**かける。
 *
 * ⚠️ **金額の計算はここでしない。** ここが持つのは「率をいくつにするか」
 * まで。注文ごとの手数料額・配分額は注文作成時にスナップショットされ、
 * あとから率を変えても過去の注文は動かない。
 */

/**
 * 秘密鍵の接頭辞。
 *
 * ⚠️ **`@sengoku/config` にも同じ値がある。** あちらは起動時の検査で、
 * こちらは保存時の検査。config は依存を持てない決まりなので参照し合えない。
 * 二つがずれると片方だけ素通りするため、一致することを
 * `apps/api/tests/payment-settings.test.ts` で縛ってある。
 */
export const PAYMENT_TEST_KEY_PREFIX = 'sk_test_';
export const PAYMENT_LIVE_KEY_PREFIX = 'sk_live_';

/** Webhook 署名鍵の接頭辞。Stripe が発行する値は必ずこれで始まる。 */
export const PAYMENT_WEBHOOK_SECRET_PREFIX = 'whsec_';

/**
 * 決済事業者の API の宛先。
 *
 * ⚠️ **画面から変えさせない。** 宛先は決まっており、変えられる口を
 * 作る意味が無い。むしろ変えられると、鍵ごと別の宛先へ送らせる経路になる。
 * ここに置いてあるのは、到達性の確認先として使うためと、
 * 「どこへ送っているか」を人が確かめられるようにするため。
 */
export const PAYMENT_API_ENDPOINT = 'https://api.stripe.com';

/** 手数料率の上限（100%）。 */
export const PLATFORM_FEE_RATE_BPS_MAX = 10_000;

/**
 * 決済に固有の設定。
 *
 * ⚠️ **接続先（`endpointUrl`）は画面から変えさせない。** 決済事業者の
 * API の宛先は決まっており、変えられる口を作る意味が無い。むしろ
 * 変えられると、鍵ごと別の宛先へ送らせる経路になる。
 */
export interface PaymentSettingsFields {
  /** 決済事業者の API 版。空なら実装側の既定に従う。 */
  readonly apiVersion: string | null;
  /** 支払い完了後に購入者を戻す先。`{ORDER_ID}` を含める。 */
  readonly checkoutSuccessUrl: string | null;
  /** 支払いをやめたときに戻す先。 */
  readonly checkoutCancelUrl: string | null;
  /**
   * プラットフォーム手数料（ベーシスポイント）。
   *
   * ⚠️ **0 は「手数料無料」ではなく「販売設定が未完了」。**
   * 0 のまま売れてしまうと、こちらの取り分が無い注文が成立し、
   * あとから購入者へ請求し直すことはできない。「無料で売れる」より
   * 「売れない」ほうが取り返しがつくので、0 では支払い口を作らせない。
   */
  readonly platformFeeRateBps: number;
}

export interface UpdatePaymentSettingsInput {
  readonly apiVersion?: string | null;
  readonly checkoutSuccessUrl?: string | null;
  readonly checkoutCancelUrl?: string | null;
  readonly platformFeeRateBps?: number;
}

/**
 * 秘密鍵が、その環境で使ってよいものか。
 *
 * ⚠️ **取り違えの向きで、起きることが違う。**
 *  production にテスト鍵 → 決済は通るのに 1 円も入らない
 *  それ以外に本番鍵     → 試験のつもりで本物のお金が動く
 * 後者のほうが取り返しがつかないが、どちらも本番運用では致命的なので
 * 両方断る。
 *
 * ⚠️ **理由に鍵の値を載せない。** 画面にもログにも出る文字列なので、
 * 「どこまで合っていたか」すら手掛かりになる。
 */
export function validateSecretKeyForEnvironment(
  key: string,
  environment: IntegrationEnvironment,
): Result<void, DomainError> {
  const isTest = key.startsWith(PAYMENT_TEST_KEY_PREFIX);
  const isLive = key.startsWith(PAYMENT_LIVE_KEY_PREFIX);

  if (!isTest && !isLive) {
    return err(
      domainError('PAYMENT_SECRET_INVALID', 'secret key must start with sk_test_ or sk_live_'),
    );
  }
  if (environment === 'production' && isTest) {
    return err(domainError('PAYMENT_SECRET_ENVIRONMENT_MISMATCH', 'test key on production'));
  }
  if (environment !== 'production' && isLive) {
    return err(domainError('PAYMENT_SECRET_ENVIRONMENT_MISMATCH', 'live key outside production'));
  }
  return ok(undefined);
}

/**
 * Webhook 署名鍵の形を確かめる。
 *
 * ⚠️ **形だけで、正しさは確かめていない。** 正しいかどうかは、実際に
 * 署名付きの通知が届いて検証が通るまで分からない。ここで弾けるのは
 * 「明らかに別の値を貼った」場合だけ。
 */
export function validateWebhookSecret(secret: string): Result<void, DomainError> {
  if (!secret.startsWith(PAYMENT_WEBHOOK_SECRET_PREFIX)) {
    return err(domainError('PAYMENT_SECRET_INVALID', 'webhook secret must start with whsec_'));
  }
  return ok(undefined);
}

/**
 * 戻り先の URL を確かめる。
 *
 * ⚠️ **https に限る。** 購入者のブラウザがここへ戻る。平文だと
 * 経路上で書き換えられ、偽の「お支払いが完了しました」を見せられる。
 *
 * ⚠️ **成功URLには `{ORDER_ID}` を必須にする。** 無いと、どの注文の
 * 結果を見せればよいか画面が判断できず、直前の注文を出すような
 * 危うい作りへ倒れる。
 */
export const ORDER_ID_PLACEHOLDER = '{ORDER_ID}';

function validateReturnUrl(
  value: string,
  requirePlaceholder: boolean,
): Result<string, DomainError> {
  if (!value.startsWith('https://')) {
    return err(domainError('PAYMENT_SETTINGS_INVALID', 'return url must be https'));
  }
  if (requirePlaceholder && !value.includes(ORDER_ID_PLACEHOLDER)) {
    return err(domainError('PAYMENT_SETTINGS_INVALID', 'success url must contain the placeholder'));
  }
  return ok(value);
}

export function updatePaymentSettings(
  current: PaymentSettingsFields,
  input: UpdatePaymentSettingsInput,
): Result<PaymentSettingsFields, DomainError> {
  const successRaw =
    input.checkoutSuccessUrl === undefined ? current.checkoutSuccessUrl : input.checkoutSuccessUrl;
  const cancelRaw =
    input.checkoutCancelUrl === undefined ? current.checkoutCancelUrl : input.checkoutCancelUrl;

  const success = emptyToNull(successRaw);
  const cancel = emptyToNull(cancelRaw);

  if (success !== null) {
    const checked = validateReturnUrl(success, true);
    if (!checked.ok) {
      return checked;
    }
  }
  if (cancel !== null) {
    const checked = validateReturnUrl(cancel, false);
    if (!checked.ok) {
      return checked;
    }
  }

  const feeRateBps =
    input.platformFeeRateBps === undefined ? current.platformFeeRateBps : input.platformFeeRateBps;
  if (
    !Number.isSafeInteger(feeRateBps) ||
    feeRateBps < 0 ||
    feeRateBps > PLATFORM_FEE_RATE_BPS_MAX
  ) {
    return err(domainError('PAYMENT_SETTINGS_INVALID', 'fee rate out of range'));
  }

  return ok({
    apiVersion: emptyToNull(input.apiVersion === undefined ? current.apiVersion : input.apiVersion),
    checkoutSuccessUrl: success,
    checkoutCancelUrl: cancel,
    platformFeeRateBps: feeRateBps,
  });
}

/**
 * 販売の設定がそろっているか。
 *
 * ⚠️ **「有効化できるか」とは別。** こちらは金額の話（率が入っているか）で、
 * 有効化は接続の話（鍵と接続テスト）。片方だけ満たしても売れない。
 */
export function isSalesSetupComplete(fields: PaymentSettingsFields): boolean {
  return fields.platformFeeRateBps > 0;
}

function emptyToNull(value: string | null): string | null {
  return value === null || value.trim() === '' ? null : value.trim();
}
