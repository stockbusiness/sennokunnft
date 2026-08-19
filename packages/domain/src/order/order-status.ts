import { domainError, type DomainError } from '../shared/errors';
import { err, ok, type Result } from '../shared/result';

/**
 * 注文まわりの状態（決済仕様書 §7・指示書 §7）。
 *
 * ⚠️ **1 本の列に詰め込まない。** 「決済は成功したが付与に失敗した」
 * 「決済成功のあと一部返金された」のような組み合わせは、実際に起きる。
 * 1 本にまとめると、どちらか一方しか表せず、表せないほうが失われる。
 *
 * ⚠️ **画面の代表状態と、記録の状態を混同しない。** 仕様書 §7 の表は
 * 業務上の言い方をまとめたもので、保存するのはここの 4 本。
 */

// --- 注文そのものの進み具合 --------------------------------------------------

/**
 * ⚠️ `failed` と `refunded` は**この列では使わない**。
 * 決済の失敗は `PaymentStatus`、返金は `RefundStatus` が持つ。
 * DB の列挙型には過去の実装が入れた値として残っているが、
 * 新しい注文がこれらへ遷移することはない（下の遷移表に無い）。
 */
export const ORDER_STATUSES = [
  'pending',
  'checkout_created',
  'paid',
  'expired',
  'cancelled',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

// --- 決済 --------------------------------------------------------------------

export const PAYMENT_STATUSES = [
  'not_started',
  'pending',
  'succeeded',
  'failed',
  'cancelled',
  'refunded',
] as const;
export type OrderPaymentStatus = (typeof PAYMENT_STATUSES)[number];

// --- 付与（受取権の発行と Wallet への引き渡し）--------------------------------

export const FULFILLMENT_STATUSES = ['not_started', 'processing', 'fulfilled', 'failed'] as const;
export type FulfillmentStatus = (typeof FULFILLMENT_STATUSES)[number];

// --- 返金 --------------------------------------------------------------------

export const REFUND_STATUSES = [
  'none',
  'pending',
  'partially_refunded',
  'refunded',
  'failed',
] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

/**
 * 許された遷移。
 *
 * ⚠️ **既定は拒否。** ここに書かれていない組み合わせはすべて通らない。
 * 「書き忘れたら通ってしまう」ではなく「書き忘れたら止まる」向きにする。
 *
 * ⚠️ **同じ状態への遷移も許さない。** 「すでにその状態」は遷移ではなく、
 * 呼び出し側が冪等に扱うべきこと。ここで許すと、二重処理が
 * 「遷移できたのだから 1 回目」として通ってしまう。
 */
const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  pending: ['checkout_created', 'expired', 'cancelled'],
  // ⚠️ `checkout_created` からも期限切れ・取消へ行ける。
  //    Checkout を作ったあとに離脱する人は必ずいる。
  checkout_created: ['paid', 'expired', 'cancelled'],
  // 支払い済みの注文を期限切れにしない。お金を受け取ったあとに
  // 「期限切れ」で在庫を戻すと、売った物が消える。
  paid: [],
  expired: [],
  cancelled: [],
};

const PAYMENT_TRANSITIONS: Readonly<Record<OrderPaymentStatus, readonly OrderPaymentStatus[]>> = {
  not_started: ['pending', 'cancelled'],
  pending: ['succeeded', 'failed', 'cancelled'],
  // ⚠️ 成功から失敗へは戻さない。決済事業者側で成功した事実は消えない。
  //    取り消したいときは返金（`RefundStatus`）で表す。
  succeeded: ['refunded'],
  failed: [],
  cancelled: [],
  refunded: [],
};

const FULFILLMENT_TRANSITIONS: Readonly<Record<FulfillmentStatus, readonly FulfillmentStatus[]>> = {
  not_started: ['processing'],
  processing: ['fulfilled', 'failed'],
  fulfilled: [],
  // ⚠️ 失敗から処理中へ戻せる。付与の失敗は運用で再試行するもので、
  //    終わりではない。ここを終端にすると、直せるものが直せなくなる。
  failed: ['processing'],
};

const REFUND_TRANSITIONS: Readonly<Record<RefundStatus, readonly RefundStatus[]>> = {
  none: ['pending'],
  pending: ['partially_refunded', 'refunded', 'failed'],
  partially_refunded: ['pending', 'refunded'],
  refunded: [],
  failed: ['pending'],
};

function transition<T extends string>(
  table: Readonly<Record<T, readonly T[]>>,
  from: T,
  to: T,
): Result<T, DomainError> {
  const allowed = table[from];
  if (!allowed.includes(to)) {
    // ⚠️ 値そのものをメッセージに載せない。API のエラーへそのまま出ると、
    //    内部の状態名が外へ漏れる。何が起きたかは符号で分かる。
    return err(domainError('ORDER_TRANSITION_NOT_ALLOWED', 'transition is not allowed'));
  }
  return ok(to);
}

export function transitionOrderStatus(
  from: OrderStatus,
  to: OrderStatus,
): Result<OrderStatus, DomainError> {
  return transition(ORDER_TRANSITIONS, from, to);
}

export function transitionPaymentStatus(
  from: OrderPaymentStatus,
  to: OrderPaymentStatus,
): Result<OrderPaymentStatus, DomainError> {
  return transition(PAYMENT_TRANSITIONS, from, to);
}

export function transitionFulfillmentStatus(
  from: FulfillmentStatus,
  to: FulfillmentStatus,
): Result<FulfillmentStatus, DomainError> {
  return transition(FULFILLMENT_TRANSITIONS, from, to);
}

export function transitionRefundStatus(
  from: RefundStatus,
  to: RefundStatus,
): Result<RefundStatus, DomainError> {
  return transition(REFUND_TRANSITIONS, from, to);
}

/** その注文がもう動かないか（終端に達したか）。 */
export function isOrderFinal(status: OrderStatus): boolean {
  return ORDER_TRANSITIONS[status].length === 0;
}

export function isOrderStatus(value: string): value is OrderStatus {
  return (ORDER_STATUSES as readonly string[]).includes(value);
}

export function isOrderPaymentStatus(value: string): value is OrderPaymentStatus {
  return (PAYMENT_STATUSES as readonly string[]).includes(value);
}

export function isFulfillmentStatus(value: string): value is FulfillmentStatus {
  return (FULFILLMENT_STATUSES as readonly string[]).includes(value);
}

export function isRefundStatus(value: string): value is RefundStatus {
  return (REFUND_STATUSES as readonly string[]).includes(value);
}
