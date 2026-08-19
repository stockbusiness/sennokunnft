import { z } from 'zod';

/**
 * 注文 API の契約（決済 Phase P0・P1）。
 *
 * ⚠️ **金額に関わる値をリクエストに置かない。** 価格・値引・手数料・
 * 通貨・クリエイター・購入者は、すべて認証情報と DB からサーバーが決める
 * （指示書 §4.2）。ここに項目を足した瞬間、ブラウザから金額を送れる道ができる。
 */

export const ORDER_STATUS_VALUES = [
  'pending',
  'checkout_created',
  'paid',
  'expired',
  'cancelled',
] as const;

export const ORDER_PAYMENT_STATUS_VALUES = [
  'not_started',
  'pending',
  'succeeded',
  'failed',
  'cancelled',
  'refunded',
] as const;

export const ORDER_FULFILLMENT_STATUS_VALUES = [
  'not_started',
  'processing',
  'fulfilled',
  'failed',
] as const;

export const ORDER_REFUND_STATUS_VALUES = [
  'none',
  'pending',
  'partially_refunded',
  'refunded',
  'failed',
] as const;

export const RESERVATION_STATUS_VALUES = ['reserved', 'consumed', 'released'] as const;

/**
 * 注文作成の要求。
 *
 * ⚠️ **これ以上の項目を受け取らない。** `listingId` は「どれを買うか」、
 * `idempotencyKey` は「同じ操作かどうか」。買う条件を決めるのに要るのは
 * この 2 つだけで、他は全部サーバー側の値である。
 */
export const createOrderRequestSchema = z.object({
  /** 買う対象（出品）。仕様書の `productId` にあたる。 */
  listingId: z.string().uuid(),
  /**
   * 画面が生成する重複防止キー。
   *
   * ⚠️ 個人情報を混ぜないよう、形式を UUID に限る。自由文字列にすると、
   * メールアドレスなどを入れる実装がいつか現れ、そのままログに残る。
   */
  idempotencyKey: z.string().uuid(),
});
export type CreateOrderRequest = z.infer<typeof createOrderRequestSchema>;

export const orderItemViewSchema = z.object({
  artworkId: z.string(),
  listingId: z.string(),
  /** ⚠️ 注文時点の作品名。マスタを引き直して表示しない。 */
  titleSnapshot: z.string(),
  unitPriceAmount: z.number().int().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  quantity: z.number().int().positive(),
  totalAmount: z.number().int().nonnegative(),
});
export type OrderItemView = z.infer<typeof orderItemViewSchema>;

/**
 * 購入者に返す注文。
 *
 * ⚠️ **手数料とクリエイター配分を含めない。** 購入者に関係が無く、
 * 事業の取り分を外へ晒すことになる。運営向けの応答にだけ載せる。
 */
export const orderViewSchema = z.object({
  id: z.string(),
  orderNumber: z.string(),
  status: z.enum(ORDER_STATUS_VALUES),
  paymentStatus: z.enum(ORDER_PAYMENT_STATUS_VALUES),
  fulfillmentStatus: z.enum(ORDER_FULFILLMENT_STATUS_VALUES),
  currency: z.string().regex(/^[A-Z]{3}$/),
  subtotalAmount: z.number().int().nonnegative(),
  discountAmount: z.number().int().nonnegative(),
  totalAmount: z.number().int().nonnegative(),
  /** お取り置きの期限。ISO 8601。 */
  reservationExpiresAt: z.string().nullable(),
  createdAt: z.string(),
  item: orderItemViewSchema.nullable(),
});
export type OrderView = z.infer<typeof orderViewSchema>;

/** 運営向けの注文。⚠️ 内訳を含む。購入者向けの応答と混ぜない。 */
export const adminOrderViewSchema = orderViewSchema.extend({
  refundStatus: z.enum(ORDER_REFUND_STATUS_VALUES),
  platformFeeRateBps: z.number().int().nonnegative(),
  platformFeeAmount: z.number().int().nonnegative(),
  creatorAmount: z.number().int().nonnegative(),
  creatorAccountId: z.string(),
  accountId: z.string(),
  paidAt: z.string().nullable(),
  reservation: z
    .object({
      status: z.enum(RESERVATION_STATUS_VALUES),
      quantity: z.number().int().positive(),
      expiresAt: z.string(),
      consumedAt: z.string().nullable(),
      releasedAt: z.string().nullable(),
    })
    .nullable(),
  /** ⚠️ 決済事業者側の識別子は返さない。有無だけで運用は足りる。 */
  hasPayment: z.boolean(),
  entitlementCount: z.number().int().nonnegative(),
  /**
   * 冪等キーの識別表示（指示書 §9.2）。
   *
   * ⚠️ **全体を返さない。** 問い合わせの突き合わせに要るのは先頭の数文字で、
   * 全体を画面に出しても運用の役に立たないまま、控えられる面が増える。
   */
  idempotencyKeyPrefix: z.string(),
});
export type AdminOrderView = z.infer<typeof adminOrderViewSchema>;

export const adminOrderListResponseSchema = z.object({
  items: z.array(adminOrderViewSchema),
  nextCursor: z.string().nullable(),
});
export type AdminOrderListResponse = z.infer<typeof adminOrderListResponseSchema>;

export const adminOrderListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
  status: z.enum(ORDER_STATUS_VALUES).optional(),
});
export type AdminOrderListQuery = z.infer<typeof adminOrderListQuerySchema>;

/** 期限切れ解放ジョブの結果。⚠️ 注文IDは返すが、購入者は返さない。 */
export const releaseExpiredResponseSchema = z.object({
  releasedCount: z.number().int().nonnegative(),
  orderIds: z.array(z.string()),
});
export type ReleaseExpiredResponse = z.infer<typeof releaseExpiredResponseSchema>;

// ---------------------------------------------------------------------------
// 決済（決済 Phase P2）
// ---------------------------------------------------------------------------

/**
 * 支払い口の作成の応答。
 *
 * ⚠️ **本文に受け取る項目は無い。** 金額も通貨も、注文IDから
 * サーバーが引く。ここへ項目を足した瞬間、ブラウザから金額を
 * 送れる道ができる（指示書 §4-6）。
 */
export const checkoutSessionResponseSchema = z.object({
  /** 利用者を送る先。 */
  checkoutUrl: z.string().url(),
  /** この口が閉じる時刻。ISO 8601。 */
  expiresAt: z.string(),
  /** 既存の口を使い回したか。画面の文言を変えるために返す。 */
  reused: z.boolean(),
});
export type CheckoutSessionResponse = z.infer<typeof checkoutSessionResponseSchema>;

export const PAYMENT_ATTEMPT_STATUS_VALUES = [
  'pending',
  'succeeded',
  'failed',
  'cancelled',
  'refunded',
] as const;

/** 運営が決済を追跡するための表示（指示書 §13）。 */
export const paymentAttemptViewSchema = z.object({
  id: z.string(),
  provider: z.string(),
  status: z.enum(PAYMENT_ATTEMPT_STATUS_VALUES),
  /** ⚠️ 識別子は出すが、秘密は出さない。問い合わせの突き合わせに要る。 */
  sessionRef: z.string().nullable(),
  paymentRef: z.string().nullable(),
  chargeRef: z.string().nullable(),
  amount: z.number().int().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  expiresAt: z.string().nullable(),
  paidAt: z.string().nullable(),
  /** ⚠️ 事業者の符号ではなく、こちらで決めた安全な符号。 */
  failureCode: z.string().nullable(),
  createdAt: z.string(),
});
export type PaymentAttemptView = z.infer<typeof paymentAttemptViewSchema>;

export const webhookReceiptViewSchema = z.object({
  eventType: z.string(),
  status: z.enum(['received', 'processed', 'ignored', 'failed']),
  livemode: z.boolean().nullable(),
  apiVersion: z.string().nullable(),
  attemptCount: z.number().int().nonnegative(),
  receivedAt: z.string(),
  processedAt: z.string().nullable(),
  lastErrorCode: z.string().nullable(),
});
export type WebhookReceiptView = z.infer<typeof webhookReceiptViewSchema>;

/** 運営の注文詳細に足す決済の情報。 */
export const adminOrderPaymentsSchema = z.object({
  attempts: z.array(paymentAttemptViewSchema),
  webhooks: z.array(webhookReceiptViewSchema),
  /** 注文金額と、事業者が受け取った額が一致しているか。 */
  amountMatches: z.boolean().nullable(),
});
export type AdminOrderPayments = z.infer<typeof adminOrderPaymentsSchema>;

/**
 * 運営の注文詳細。
 *
 * ⚠️ **`payments` は省略できる。** 決済を繋いでいない配備では節ごと
 * 出さない。空の表を出すと「まだ来ていない」のか「繋がっていない」のか
 * 分からない。
 */
export const adminOrderDetailSchema = adminOrderViewSchema.extend({
  payments: adminOrderPaymentsSchema.optional(),
});
export type AdminOrderDetail = z.infer<typeof adminOrderDetailSchema>;
