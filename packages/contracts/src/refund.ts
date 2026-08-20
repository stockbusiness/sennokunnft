import { z } from 'zod';

/**
 * 返金（`UD-104` / `UD-120`。決定 2026-08-20）。
 *
 * ⚠️ **金額を受け取る欄を作らない。** 一部返金は自動処理しない決定なので、
 * 返すのは常に残額の全部。額を画面から受け取ると、桁を 1 つ多く打った
 * 操作がそのまま通る。押せる操作を減らすことが、いちばん確実な守りになる。
 */

export const REFUND_REASON_VALUES = ['buyer_request', 'our_fault', 'provider_initiated'] as const;
export const REFUND_RECORD_STATUS_VALUES = ['requested', 'succeeded', 'failed'] as const;
export const REFUND_INITIATOR_VALUES = ['admin', 'provider'] as const;

export const refundRecordSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  amount: z.number().int(),
  currency: z.string(),
  reason: z.enum(REFUND_REASON_VALUES),
  status: z.enum(REFUND_RECORD_STATUS_VALUES),
  /** ⚠️ 事業者の画面からの返金を、運営の操作と混ぜない。 */
  initiatedBy: z.enum(REFUND_INITIATOR_VALUES),
  /** ⚠️ 氏名やメールではなくアカウントID。画面では短縮して出す。 */
  actorAccountId: z.string().nullable(),
  note: z.string().nullable(),
  failureCode: z.string().nullable(),
  createdAt: z.string(),
  settledAt: z.string().nullable(),
});
export type RefundRecordViewDto = z.infer<typeof refundRecordSchema>;

export const refundListResponseSchema = z.object({
  items: z.array(refundRecordSchema),
});
export type RefundListResponse = z.infer<typeof refundListResponseSchema>;

/**
 * 返金の依頼。
 *
 * ⚠️ `provider_initiated` は受け付けない。あれは「事業者の画面で
 * すでに返金された」という事実の記録であって、こちらから起こす理由ではない。
 */
export const createRefundRequestSchema = z.object({
  reason: z.enum(['buyer_request', 'our_fault']),
  /**
   * 発行が進んだ注文でも進める、という運営の判断（`UD-104`）。
   *
   * ⚠️ **省略時は `false`。** 「発行済みは回収できない」を押し慣れで
   * 越えられるようにしない。画面は必ず 1 度断ってから出し直す。
   */
  acknowledgeIssued: z.boolean().optional(),
  /** 運用の注記。⚠️ 購入者へは出さない。 */
  note: z.string().trim().max(1000).optional(),
});
export type CreateRefundRequest = z.infer<typeof createRefundRequestSchema>;

/** 返金した結果。⚠️ 何が起きたかを丸めずに返す。 */
export const refundResultSchema = z.object({
  refund: refundRecordSchema,
  /** 注文の返金状態。 */
  refundStatus: z.string(),
  amountRefunded: z.number().int(),
  revokedEntitlements: z.number().int(),
  cancelledMintJobs: z.number().int(),
  /** ⚠️ 取り消せなかった発行ジョブ（`processing`）。注記だけ足した数。 */
  annotatedMintJobs: z.number().int(),
  restoredSupply: z.number().int(),
});
export type RefundResult = z.infer<typeof refundResultSchema>;
