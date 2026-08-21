import type { IdentityVerificationMethod } from '@sengoku/domain';
import {
  CUSTOMER_ATTENTION_KEYS,
  DUPLICATE_SIGNALS,
  EMAIL_CHANGE_STATUSES,
  IDENTITY_VERIFICATION_METHODS,
} from '@sengoku/domain';
import { z } from 'zod';

/**
 * 顧客サポート（P1-1）の契約。
 *
 * ⚠️ **氏名とメールアドレスの平文の項目を作らない**（`UD-503`）。
 * 項目そのものが無ければ、実装がうっかり載せても型で落ちる。
 *
 * ⚠️ **持ち主を付け替える口の契約を書かない**（指示書 §11）。書かなければ、
 * あとから足す人がまずここを読み、理由に行き当たる。
 */

export const customerSummarySchema = z.object({
  accountId: z.string(),
  /** ⚠️ 平文を持っていないので、いまは常に `null`。 */
  maskedEmail: z.string().nullable(),
  commonUserId: z.string().nullable(),
  status: z.enum(['active', 'suspended']),
  orderCount: z.number().int().nonnegative(),
  paidAmount: z.number().int(),
  refundedAmount: z.number().int(),
  /** ⚠️ 画面で引き算をさせないため、サーバー側で出す。 */
  netPaidAmount: z.number().int(),
  entitlementCount: z.number().int().nonnegative(),
  unclaimedCount: z.number().int().nonnegative(),
  firstOrderAt: z.string().nullable(),
  lastOrderAt: z.string().nullable(),
});
export type CustomerSummaryView = z.infer<typeof customerSummarySchema>;

export const customerAttentionSchema = z.object({
  key: z.enum(CUSTOMER_ATTENTION_KEYS),
  label: z.string(),
  detail: z.string(),
});
export type CustomerAttentionView = z.infer<typeof customerAttentionSchema>;

/** ⚠️ お受け取りの合言葉の項目は無い。 */
export const customerEntitlementSchema = z.object({
  id: z.string(),
  orderNumber: z.string(),
  artworkTitle: z.string(),
  serialNo: z.number().int().positive(),
  status: z.string(),
  walletDeliveryStatus: z.string(),
  claimedAt: z.string().nullable(),
  walletDeliveredAt: z.string().nullable(),
});

export const customerOrderSchema = z.object({
  id: z.string(),
  orderNumber: z.string(),
  status: z.string(),
  paymentStatus: z.string(),
  refundStatus: z.string(),
  totalAmount: z.number().int(),
  createdAt: z.string(),
  paidAt: z.string().nullable(),
});

export const customerRefundSchema = z.object({
  id: z.string(),
  orderNumber: z.string(),
  amount: z.number().int(),
  reason: z.string(),
  status: z.string(),
  createdAt: z.string(),
});

export const accountNoteSchema = z.object({
  id: z.string(),
  authorAccountId: z.string(),
  body: z.string(),
  createdAt: z.string(),
});
export type AccountNoteView = z.infer<typeof accountNoteSchema>;

/** ⚠️ **「候補」であって「同一人物」ではない。** 文言も型名もそう読ませない。 */
export const duplicateCandidateSchema = z.object({
  accountId: z.string(),
  maskedEmail: z.string().nullable(),
  commonUserId: z.string().nullable(),
  status: z.enum(['active', 'suspended']),
  orderCount: z.number().int().nonnegative(),
  entitlementCount: z.number().int().nonnegative(),
  signals: z.array(z.enum(DUPLICATE_SIGNALS)),
  createdAt: z.string(),
});
export type DuplicateCandidateView = z.infer<typeof duplicateCandidateSchema>;

export const emailChangeRequestSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  /** ⚠️ 伏せた表記。元へは戻せない。 */
  requestedMaskedEmail: z.string(),
  status: z.enum(EMAIL_CHANGE_STATUSES),
  verificationMethod: z.enum(IDENTITY_VERIFICATION_METHODS).nullable(),
  verifiedByAccountId: z.string().nullable(),
  verifiedAt: z.string().nullable(),
  settledByAccountId: z.string().nullable(),
  settledAt: z.string().nullable(),
  note: z.string().nullable(),
  openedByAccountId: z.string(),
  createdAt: z.string(),
});
export type EmailChangeRequestView = z.infer<typeof emailChangeRequestSchema>;

/** 顧客 1 人の全体。⚠️ 応対のときに開く 1 画面ぶん。 */
export const customerDetailResponseSchema = z.object({
  summary: customerSummarySchema,
  /** ⚠️ 何も無ければ空。「問題ありません」という行は作らない。 */
  attentions: z.array(customerAttentionSchema),
  orders: z.array(customerOrderSchema),
  entitlements: z.array(customerEntitlementSchema),
  refunds: z.array(customerRefundSchema),
  notes: z.array(accountNoteSchema),
  duplicateCandidates: z.array(duplicateCandidateSchema),
  emailChangeRequests: z.array(emailChangeRequestSchema),
  /**
   * 代理店・紹介元のスナップショット。
   *
   * ⚠️ **いまは常に `null`。** 代理店システムとの連携（M0〜M4）が
   * 契約待ちで、注文に紹介元を残す列がまだ無い。**「無い」ことを
   * 項目として出しておく**のは、あとから足す人が形を揃えられるように
   * するためで、埋まっているふりをするためではない。
   */
  referralSnapshot: z.null(),
});
export type CustomerDetailResponse = z.infer<typeof customerDetailResponseSchema>;

export const customerSearchResponseSchema = z.object({
  items: z.array(customerSummarySchema),
});
export type CustomerSearchResponse = z.infer<typeof customerSearchResponseSchema>;

/**
 * 顧客の検索。
 *
 * ⚠️ **平文のアドレスで引く口はここだけ。** 受け取ったらすぐ照合値へ
 * 変換して捨てる（`UD-121` の注文検索と同じ扱い）。
 */
export const customerSearchRequestSchema = z
  .object({
    email: z.string().email().optional(),
    commonUserId: z.string().optional(),
    orderNumber: z.string().optional(),
    accountId: z.string().uuid().optional(),
  })
  .refine(
    (value) =>
      value.email !== undefined ||
      value.commonUserId !== undefined ||
      value.orderNumber !== undefined ||
      value.accountId !== undefined,
    // ⚠️ 条件無しの全件表示を作らない。顧客の一覧をただ眺める画面にしない。
    { message: '検索の手がかりを 1 つ以上指定してください。' },
  );
export type CustomerSearchRequest = z.infer<typeof customerSearchRequestSchema>;

export const addAccountNoteRequestSchema = z.object({
  body: z.string().min(1).max(2000),
});

export const openEmailChangeRequestSchema = z.object({
  /** ⚠️ 受け取るのは平文だが、保存するのは伏せた表記と照合値だけ。 */
  newEmail: z.string().email(),
});

export const verifyIdentityRequestSchema = z.object({
  method: z.enum(IDENTITY_VERIFICATION_METHODS),
  note: z.string().max(1000).nullable().default(null),
});

export const settleEmailChangeRequestSchema = z.object({
  status: z.enum(['completed', 'rejected']),
  note: z.string().max(1000).nullable().default(null),
});

/**
 * 本人確認の方法の語彙。
 *
 * ⚠️ **`@sengoku/domain` から素通しする。** 画面は domain へ依存できない
 * （依存検査で止まる）ので、通り道はここしか無い。ここで別に定義すると、
 * 方法を増やしたときに画面だけ古いままになる。
 */
export { IDENTITY_VERIFICATION_METHODS };
export type { IdentityVerificationMethod };
