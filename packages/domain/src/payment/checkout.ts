import { domainError, type DomainError } from '../shared/errors';
import { err, ok, type Result } from '../shared/result';
import type { OrderPaymentStatus, OrderStatus } from '../order/order-status';

/**
 * 決済を始めてよいかの判定（決済 Phase P2・指示書 §5.2）。
 *
 * ⚠️ **決済事業者を知らない。** Stripe の語彙をここへ持ち込まない。
 * 判定するのは「この注文はいま支払いを受け付けてよいか」だけで、
 * どの事業者でどう払うかは境界の外。
 */

/** 決済事業者側の支払い口。1 回の試行に 1 つ。 */
export interface CheckoutSessionSnapshot {
  readonly paymentId: string;
  /** 事業者側のセッション識別子。 */
  readonly sessionRef: string;
  /** この口へ利用者を送る先。 */
  readonly url: string | null;
  readonly status: OrderPaymentStatus;
  /** この口が使えなくなる時刻。 */
  readonly expiresAt: Date;
}

export interface CheckoutEligibilityInput {
  readonly orderStatus: OrderStatus;
  readonly paymentStatus: OrderPaymentStatus;
  /** 注文時に焼き付けた手数料率（bps）。 */
  readonly platformFeeRateBps: number;
  /** 在庫のお取り置きの期限。無いなら決済を始めさせない。 */
  readonly reservationExpiresAt: Date | null;
  /** いま生きている支払い口。無ければ `null`。 */
  readonly existingSession: CheckoutSessionSnapshot | null;
  readonly now: Date;
}

/**
 * 判定の結果。
 *
 * ⚠️ **`reuse` を `create` に丸めない。** 押すたびに新しい口を作ると、
 * 同じ注文に対する支払い口が複数生き、両方で払える状態になる。
 */
export type CheckoutDecision =
  | { readonly kind: 'reuse'; readonly session: CheckoutSessionSnapshot }
  | { readonly kind: 'create'; readonly expiresAt: Date };

/**
 * 支払い口を作ってよいか、既存を使い回すかを決める。
 *
 * ⚠️ **判定の順序に意味がある。**
 * 販売設定 → 支払済み → 期限 → 既存の口、の順に見る。
 * 期限を先に見ると、設定が未完了の作品について「まだ買えます」と
 * 答えてしまう。
 */
export function decideCheckout(
  input: CheckoutEligibilityInput,
): Result<CheckoutDecision, DomainError> {
  // 1. 販売の設定が終わっているか。
  //    ⚠️ 手数料率 0 は「無料」ではなく「未設定」（UD-109）。
  //    ここを通すと、率を決める前に 0% で売れてしまう。
  if (input.platformFeeRateBps <= 0) {
    return err(domainError('SALES_SETUP_INCOMPLETE', 'platform fee rate is not configured'));
  }

  // 2. もう払い終わっている注文に、新しい支払い口を作らない。
  //    ⚠️ 作ると二重に払える。返金でしか戻せない。
  if (input.orderStatus === 'paid' || input.paymentStatus === 'succeeded') {
    return err(domainError('CHECKOUT_NOT_ALLOWED', 'order is already paid'));
  }
  if (input.orderStatus === 'expired' || input.orderStatus === 'cancelled') {
    return err(domainError('CHECKOUT_NOT_ALLOWED', 'order is closed'));
  }

  // 3. お取り置きの期限。切れていたら、在庫はもう他の人のもの。
  if (input.reservationExpiresAt === null) {
    return err(domainError('CHECKOUT_NOT_ALLOWED', 'order has no reservation'));
  }
  if (input.reservationExpiresAt.getTime() <= input.now.getTime()) {
    return err(domainError('RESERVATION_EXPIRED', 'reservation has expired'));
  }

  // 4. 生きている支払い口があれば、それを使い回す。
  const existing = input.existingSession;
  if (existing !== null && isSessionUsable(existing, input.now)) {
    return ok({ kind: 'reuse', session: existing });
  }

  /*
    5. 新しい口を作る。
    ⚠️ **口の期限は、お取り置きの期限を超えさせない**（指示書 §5.3）。
       超えると、在庫を解放したあとに支払えてしまう。払った人には
       商品が無く、返金の説明から始めることになる。
  */
  return ok({ kind: 'create', expiresAt: input.reservationExpiresAt });
}

/**
 * その支払い口はまだ使えるか。
 *
 * ⚠️ **`pending` だけを使い回す。** 失敗・取消の口を再利用すると、
 * 決済事業者側で使えないものへ利用者を送ることになる。
 */
export function isSessionUsable(session: CheckoutSessionSnapshot, now: Date): boolean {
  if (session.status !== 'pending') {
    return false;
  }
  if (session.url === null || session.url === '') {
    return false;
  }
  return session.expiresAt.getTime() > now.getTime();
}
