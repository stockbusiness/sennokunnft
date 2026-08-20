import { z } from 'zod';

/**
 * 運用確認キューの読み書き（M3a）。
 *
 * ⚠️ **個人情報を載せる項目を作らない。** ここに出るのは
 * 「機械が決められなかったこと」であり、識別子と理由まででたどれる。
 * 氏名・メール・共通顧客ID・金額の項目を作らなければ、実装側が
 * うっかり載せても型で落ちる。
 */

export const OPERATIONS_REVIEW_STATUS_VALUES = ['open', 'resolved'] as const;

export const OPERATIONS_REVIEW_REASON_VALUES = [
  'partial_refund_entitlement_unresolved',
  'wallet_revocation_recipient_unresolved',
  'wallet_revocation_payload_conflict',
] as const;

export const operationsReviewSchema = z.object({
  id: z.string(),
  subjectType: z.enum(['order', 'entitlement']),
  subjectId: z.string(),
  orderId: z.string().nullable(),
  reasonCode: z.enum(OPERATIONS_REVIEW_REASON_VALUES),
  /** 機械が判断できなかった理由。⚠️ 個人情報は入らない。 */
  detail: z.string(),
  status: z.enum(OPERATIONS_REVIEW_STATUS_VALUES),
  /** 対応した運営スタッフ。⚠️ 氏名ではなくアカウントID。 */
  resolvedByAccountId: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  resolutionNote: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type OperationsReviewView = z.infer<typeof operationsReviewSchema>;

export const operationsReviewListResponseSchema = z.object({
  items: z.array(operationsReviewSchema),
  nextCursor: z.string().nullable(),
  /**
   * 未対応の件数。⚠️ **絞り込みの影響を受けない全体の件数。**
   * 絞った結果の件数を出すと、「0 件だから何も無い」と読み違える。
   */
  openCounts: z.record(z.enum(OPERATIONS_REVIEW_REASON_VALUES), z.number().int().nonnegative()),
});
export type OperationsReviewListResponse = z.infer<typeof operationsReviewListResponseSchema>;

/** 対応済みにするときの入力。 */
export const resolveOperationsReviewRequestSchema = z.object({
  /** 対応の記録。⚠️ 個人情報を書かない旨は画面側の注意書きで伝える。 */
  note: z.string().trim().min(1).max(1000).nullable().default(null),
});
export type ResolveOperationsReviewRequest = z.infer<typeof resolveOperationsReviewRequestSchema>;
