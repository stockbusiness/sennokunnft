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
  /**
   * ⚠️ **注文時点の出品者のお名前。** 作品名・価格と同じく、注文の記録は
   * 「そのとき何が表示されていたか」を残す。出品者があとから改名しても、
   * この注文の表示は動かない。
   *
   * ⚠️ お名前を登録していない方から買った注文は `null`。
   */
  creatorNameSnapshot: z.string().nullable(),
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

/**
 * 運営の注文検索（`UD-121`）。
 *
 * ⚠️ **メールアドレスをここに置かない。** URL の問い合わせ文字列は
 * アクセスログ・ブラウザの履歴・共有されたリンクに残る。平文を持たないと
 * 決めた値（`UD-503`）を、保持しない代わりにログへ撒くことになる。
 * メールからの照合は `POST .../search` で本文として受け取る。
 */
export const adminOrderListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
  status: z.enum(ORDER_STATUS_VALUES).optional(),
  paymentStatus: z.enum(ORDER_PAYMENT_STATUS_VALUES).optional(),
  /** 完全一致、または末尾 8 文字。電話で聞き取れるのは末尾だけのことが多い。 */
  orderNumber: z.string().max(64).optional(),
  /**
   * 期間。**JST の日付**（`YYYY-MM-DD`）。
   *
   * ⚠️ **時刻を受け取らない。** 探す人が見ているのは日付であって、
   * 何時何分ではない。境界（その日の始まりと終わり）の解釈は
   * ドメイン側に 1 か所だけ置く（`normalizeOrderSearch`）。
   * ⚠️ 「から」が「まで」より後なら 400 で返す。
   */
  createdFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/u)
    .optional(),
  createdTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/u)
    .optional(),
  /** 金額（円の整数）。⚠️ 小数を受け取らない。 */
  minTotalAmount: z.coerce.number().int().nonnegative().optional(),
  maxTotalAmount: z.coerce.number().int().nonnegative().optional(),
  /** 注文時点の作品名の部分一致。⚠️ マスタを引き直さない。 */
  artworkTitle: z.string().max(100).optional(),
});
export type AdminOrderListQuery = z.infer<typeof adminOrderListQuerySchema>;

/**
 * メールアドレスから注文を辿る要求（`UD-121`）。
 *
 * ⚠️ **本文で受け取る。** URL に置くとアクセスログへ残る。
 * ⚠️ **サーバー側で照合値へ変換し、平文は保存もログ出力もしない**（`UD-503`）。
 */
export const adminOrderEmailLookupSchema = z.object({
  email: z.string().min(3).max(254),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});
export type AdminOrderEmailLookup = z.infer<typeof adminOrderEmailLookupSchema>;

/** 期限切れ解放ジョブの結果。⚠️ 注文IDは返すが、購入者は返さない。 */
export const releaseExpiredResponseSchema = z.object({
  releasedCount: z.number().int().nonnegative(),
  orderIds: z.array(z.string()),
});
export type ReleaseExpiredResponse = z.infer<typeof releaseExpiredResponseSchema>;

/**
 * 受取権の発行ジョブの結果（P0-1）。
 *
 * ⚠️ **注文番号も購入者も返さない。** これは時計が叩く口で、応答は監視の
 * 数値として読まれる。人の情報を混ぜると、監視の記録が名簿になる。
 */
export const issueEntitlementsResponseSchema = z.object({
  /** 拾った注文の数。 */
  pickedCount: z.number().int().nonnegative(),
  /** このとき作った受取権の枚数。 */
  issuedCount: z.number().int().nonnegative(),
  /** 失敗した注文の数。⚠️ 0 でないなら、次の掃き出しが拾い直す。 */
  failedCount: z.number().int().nonnegative(),
});
export type IssueEntitlementsResponse = z.infer<typeof issueEntitlementsResponseSchema>;

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

// ---------------------------------------------------------------------------
// 問い合わせ対応（`UD-121`）
// ---------------------------------------------------------------------------

export const ORDER_TIMELINE_KIND_VALUES = [
  'order_created',
  'checkout_created',
  'checkout_expires',
  'payment_succeeded',
  'order_paid',
  'webhook_received',
  'webhook_processed',
  'reservation_consumed',
  'reservation_released',
  'reservation_expires',
  'support_note',
] as const;

/**
 * 注文の経過 1 行ぶん。
 *
 * ⚠️ **`detail` に購入者の個人情報・秘匿値を入れない。** 経過は
 * 問い合わせのたびに開かれ、画面のまま読み上げられることもある。
 */
export const orderTimelineEntrySchema = z.object({
  kind: z.enum(ORDER_TIMELINE_KIND_VALUES),
  at: z.string(),
  detail: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});
export type OrderTimelineEntryView = z.infer<typeof orderTimelineEntrySchema>;

export const adminOrderTimelineResponseSchema = z.object({
  entries: z.array(orderTimelineEntrySchema),
});
export type AdminOrderTimelineResponse = z.infer<typeof adminOrderTimelineResponseSchema>;

/** 対応メモの本文の上限。ドメインの `ORDER_NOTE_MAX_LENGTH` と同じ値。 */
export const ORDER_NOTE_MAX_LENGTH = 2000;

/**
 * 対応メモの追加。
 *
 * ⚠️ **更新・削除の契約を作らない。** 追記のみ（`UD-121`）。
 */
export const createOrderNoteRequestSchema = z.object({
  body: z.string().min(1).max(ORDER_NOTE_MAX_LENGTH),
});
export type CreateOrderNoteRequest = z.infer<typeof createOrderNoteRequestSchema>;

export const orderNoteViewSchema = z.object({
  id: z.string(),
  /** ⚠️ 氏名やメールではなくアカウントID。誰かの特定は運営側の名簿で行う。 */
  authorAccountId: z.string(),
  body: z.string(),
  createdAt: z.string(),
});
export type OrderNoteView = z.infer<typeof orderNoteViewSchema>;

export const adminOrderNotesResponseSchema = z.object({
  notes: z.array(orderNoteViewSchema),
});
export type AdminOrderNotesResponse = z.infer<typeof adminOrderNotesResponseSchema>;
