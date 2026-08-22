import type { DisputeReason, DisputeStatus } from './dispute';
import { domainError, type DomainError } from '../shared/errors';
import { err, ok, type Result } from '../shared/result';

/**
 * 決済事業者から届いた知らせを、業務の事象へ正規化する（指示書 §6）。
 *
 * ⚠️ **事業者のイベント名ごとに注文を進めない。** 1 回の支払いについて
 * 複数の知らせが届く（Checkout 完了と Payment Intent 成功など）。
 * 名前ごとに処理を書くと、同じ支払いで注文を 2 回進めることになる。
 * 「決済が成功した」「決済が失敗した」「支払い口の期限が切れた」の
 * **3 つだけ**に畳んでから扱う。
 *
 * ⚠️ **事業者固有の型をここへ持ち込まない。** Stripe の SDK 型は
 * `@sengoku/integrations` の Adapter で止める。
 */

export const PAYMENT_FACTS = [
  'succeeded',
  'failed',
  'checkout_expired',
  /**
   * 返金された（`UD-120`）。
   *
   * ⚠️ **こちらから投げたぶんも、事業者の画面から返したぶんも、同じ形で
   * 届く。** 運営が慌てて事業者の管理画面から返金するのは実際に起きる。
   * 「こちら発の返金だけ追随する」にすると、そのとき状態がずれたまま
   * 誰も気づかない。
   */
  'refunded',
  /**
   * 争いが起きた／決着した（チャージバック）。
   *
   * ⚠️ **返金と分けている。** 争いが起きただけでは何も返っていない。
   * 同じ `refunded` に畳むと、申し立てを受けた時点で受取権を取り消す
   * ことになり、**こちらが勝ったときに返せない**。
   */
  'disputed',
  'ignored',
] as const;
export type PaymentFactKind = (typeof PAYMENT_FACTS)[number];

/** 事業者から来た、注文と突き合わせるための値。 */
export interface ProviderPaymentFact {
  readonly kind: PaymentFactKind;
  /** 事業者が採番したイベントID。冪等性の鍵。 */
  readonly eventId: string;
  readonly eventType: string;
  /** 固定した API バージョン。ずれていたら形が違う可能性がある。 */
  readonly apiVersion: string | null;
  /** 本番モードで発生した事象か。 */
  readonly livemode: boolean;
  /** こちらの注文ID（metadata から取る）。 */
  readonly orderId: string | null;
  readonly sessionRef: string | null;
  readonly paymentRef: string | null;
  readonly chargeRef: string | null;
  /** 事業者が受け取った額。最小通貨単位の整数。 */
  readonly amount: number | null;
  readonly currency: string | null;
  /** 失敗のときの、こちらで決めた安全な符号。 */
  readonly failureCode: string | null;
  /**
   * 事業者が採番した返金の識別子（`kind === 'refunded'` のときだけ）。
   *
   * ⚠️ **これで二重反映を防ぐ。** こちらから投げた返金にも、あとから
   * 知らせが届く。識別子で引き当てて、同じ返金を 2 回積まないようにする。
   */
  readonly refundRef: string | null;
  /**
   * その決済で返された累計額。
   *
   * ⚠️ **今回返した額ではなく累計。** 事業者は「この決済でいくら返した
   * か」を積算で持つ。差分だと、知らせが前後して届いたときに合わなくなる。
   */
  readonly refundedTotal: number | null;
  /**
   * 事業者が採番した争いの識別子（`kind === 'disputed'` のときだけ）。
   *
   * ⚠️ **これで同じ争いを 1 行に束ねる。** 申し立て・審理・決着で
   * 別々の知らせが届く。識別子で引き当てないと、1 件の争いが
   * 3 件に増える。
   */
  readonly disputeRef: string | null;
  /** 争いのいまの状態。 */
  readonly disputeStatus: DisputeStatus | null;
  /** 争われている額。⚠️ 注文の総額と一致するとは限らない。 */
  readonly disputeAmount: number | null;
  /** 事業者が言う理由。⚠️ 許可リストを通した符号のみ。 */
  readonly disputeReason: DisputeReason | null;
  readonly occurredAt: Date;
  /**
   * どの世代の鍵で署名を検証できたか（`UD-118` / `UD-128`）。
   *
   * ⚠️ **切り替え後も旧アカウントから知らせは届く。** どの世代で通ったかを
   * 残しておかないと、「まだ旧アカウント宛に決済が起きている」ことに
   * 気づけない。
   *
   * ⚠️ 緊急上書き中や `fake` では `null`。
   */
  readonly credentialId: string | null;
}

/** 注文側の、突き合わせに使う値。 */
export interface OrderPaymentExpectation {
  readonly orderId: string;
  readonly totalAmount: number;
  readonly currency: string;
  /** 支払い口を作ったときに保存した識別子。 */
  readonly sessionRef: string | null;
  readonly paymentRef: string | null;
  /** すでに成功した決済が紐付いているか。 */
  readonly hasSucceededPayment: boolean;
}

/**
 * 事業者の知らせが、こちらの注文と一致しているか（指示書 §7）。
 *
 * ⚠️ **1 つでも合わなければ注文を確定しない。** 額が違う知らせで
 * `paid` にすると、少ない入金で商品を渡すことになる。
 *
 * ⚠️ **「合わない」を利用者へ詳しく返さない。** 何が合わなかったかは
 * 運用のログにだけ残す。外から総当たりで探れる形にしない。
 */
export function verifyPaymentFact(
  fact: ProviderPaymentFact,
  expectation: OrderPaymentExpectation,
): Result<true, DomainError> {
  if (fact.orderId === null || fact.orderId !== expectation.orderId) {
    return err(domainError('PAYMENT_MISMATCH', 'order id does not match'));
  }
  if (fact.amount === null || fact.amount !== expectation.totalAmount) {
    return err(domainError('PAYMENT_MISMATCH', 'amount does not match'));
  }
  // ⚠️ 大文字小文字をそろえて比べる。事業者は小文字で返すことが多い。
  if (
    fact.currency === null ||
    fact.currency.toUpperCase() !== expectation.currency.toUpperCase()
  ) {
    return err(domainError('PAYMENT_MISMATCH', 'currency does not match'));
  }

  /*
    支払い口の識別子。
    ⚠️ **こちらが覚えているものと一致することを見る。** 見ないと、
    別の注文のために作った口の成功で、この注文を確定できてしまう。
    ⚠️ こちらが `null`（まだ保存できていない）ときは、この照合を飛ばす。
       口を作った直後に落ちた場合が該当し、他の照合はすべて通っている。
  */
  if (
    expectation.sessionRef !== null &&
    fact.sessionRef !== null &&
    fact.sessionRef !== expectation.sessionRef
  ) {
    return err(domainError('PAYMENT_MISMATCH', 'checkout session does not match'));
  }
  if (
    expectation.paymentRef !== null &&
    fact.paymentRef !== null &&
    fact.paymentRef !== expectation.paymentRef
  ) {
    return err(domainError('PAYMENT_MISMATCH', 'payment intent does not match'));
  }

  return ok(true);
}

/**
 * 本番と試験の取り違えを見つける。
 *
 * ⚠️ **`livemode` を見ないと、テストの知らせで本番の注文が確定する。**
 * Webhook の宛先は URL だけで決まるので、試験用の送信先を本番へ
 * 向けてしまう事故が起こりうる。
 */
export function isLivemodeConsistent(fact: ProviderPaymentFact, expectLive: boolean): boolean {
  return fact.livemode === expectLive;
}

/**
 * 失敗の理由を、外へ出してよい符号に畳む。
 *
 * ⚠️ **許可リストにする**（指示書 §8）。事業者の符号をそのまま保存すると、
 * カードの事情（残高不足・盗難届）まで残る。運用が知る必要があるのは
 * 「利用者側の事情か」「こちらの設定の問題か」までで足りる。
 */
const KNOWN_FAILURE_CODES = new Set([
  'card_declined',
  'expired_card',
  'incorrect_cvc',
  'processing_error',
  'authentication_required',
  'insufficient_funds',
]);

export function toSafeFailureCode(providerCode: string | null): string {
  if (providerCode === null || providerCode === '') {
    return 'unknown';
  }
  return KNOWN_FAILURE_CODES.has(providerCode) ? providerCode : 'unknown';
}
