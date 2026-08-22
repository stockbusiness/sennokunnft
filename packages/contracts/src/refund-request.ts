import { z } from 'zod';

/**
 * 返金の申請と審査（方針整理 2026-08-22）。
 *
 * ⚠️ **既存の `refund.ts` を置き換えない。** あちらは**決済事業者へ投げた
 * 返金そのもの**の記録で、こちらは**その手前の手続き**である。1 つにまとめ
 * ると、投げていない申し出と投げた返金が同じ表に混ざる。
 *
 * ⚠️ **作家さまが返金を実行する口は無い。** 作家さまにあるのは
 * 「事実確認に答える」だけで、決済事業者へ投げるのは運営だけである。
 */

export const REFUND_REQUEST_STATUS_VALUES = [
  'submitted',
  'creator_review',
  'reviewed',
  'approval_pending',
  'approved',
  'rejected',
  'executing',
  'executed',
  'execution_failed',
] as const;

export const REFUND_REQUEST_REASON_VALUES = [
  'duplicate_payment',
  'wrong_amount',
  'system_failure',
  'issuance_failed',
  'wrong_grant',
  'fraudulent_use',
  'chargeback',
  'not_as_described',
  'creator_cannot_deliver',
  'rights_infringement',
  'quality_issue',
  'buyer_change_of_mind',
  'after_transfer',
  'after_use',
  'after_resale',
] as const;

/**
 * 購入者が選べる事由。
 *
 * ⚠️ **ドメインの `BUYER_SELECTABLE_REFUND_REASONS` と同じ 12 個。**
 * 契約の側で列挙し直しているのは、`web` が `@sengoku/domain` へ依存しない
 * ため。**ずれると受け付ける事由が食い違う**ので、ドメイン側にこの一致を
 * 確かめるテストを置いてある。
 */
export const BUYER_REFUND_REASON_VALUES = REFUND_REQUEST_REASON_VALUES.filter(
  (reason) => reason !== 'chargeback' && reason !== 'wrong_grant' && reason !== 'fraudulent_use',
) as readonly (typeof REFUND_REQUEST_REASON_VALUES)[number][];

export const REFUND_CATEGORY_VALUES = [
  'operator_only',
  'creator_confirmation',
  'excluded',
] as const;

export const ENTITLEMENT_DISPOSITION_VALUES = ['revoke', 'keep'] as const;

export const refundRequestSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  status: z.enum(REFUND_REQUEST_STATUS_VALUES),
  reason: z.enum(REFUND_REQUEST_REASON_VALUES),
  /** ⚠️ 事由から機械的に決まる。画面で選び直せない。 */
  category: z.enum(REFUND_CATEGORY_VALUES),
  amount: z.number().int(),
  isFullRefund: z.boolean(),
  entitlementDisposition: z.enum(ENTITLEMENT_DISPOSITION_VALUES),
  /** ⚠️ 氏名やメールではなくアカウントID。画面では短縮して出す。 */
  requestedByAccountId: z.string().nullable(),
  reviewedByAccountId: z.string().nullable(),
  approvedByAccountId: z.string().nullable(),
  dualApprovalRequired: z.boolean(),
  approvedAsException: z.boolean(),
  rejectionNote: z.string().nullable(),
  /** できあがった返金の行。⚠️ まだ投げていなければ `null`。 */
  refundId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RefundRequestViewDto = z.infer<typeof refundRequestSchema>;

/**
 * 運営が見る 1 件。
 *
 * ⚠️ **運営の注記と購入者の申し出を分けている。** 混ぜると、購入者へ
 * 見せる画面を作ったときに運営の注記まで出る。
 */
export const adminRefundRequestDetailSchema = z.object({
  request: refundRequestSchema,
  note: z.string().nullable(),
  buyerStatement: z.string().nullable(),
  inquiry: z
    .object({
      creatorAccountId: z.string(),
      askedAt: z.string(),
      dueAt: z.string(),
      answeredAt: z.string().nullable(),
      answer: z.string().nullable(),
      /** ⚠️ 保管庫の鍵。URL ではない（画面が都度取り寄せる）。 */
      attachmentKeys: z.array(z.string()),
      /** 期限を過ぎて未回答か。⚠️ 過ぎても申請は止まらない。 */
      expired: z.boolean(),
    })
    .nullable(),
  events: z.array(
    z.object({
      id: z.string(),
      action: z.string(),
      actorAccountId: z.string().nullable(),
      summary: z.record(z.string(), z.unknown()),
      createdAt: z.string(),
    }),
  ),
  /** その注文でまだ返せる額。⚠️ 承認の金額を確かめるために出す。 */
  remainingAmount: z.number().int(),
  /**
   * この返金を誰が被るか（決定 2026-08-22）。
   *
   * ⚠️ **事由と「例外として通すか」から決まる。画面で選ばせない。** 選べる
   * ようにすると、一度の操作で作家さまへ費用を寄せられてしまう——この
   * 決定が止めたかったのは、まさにそれである。
   * ⚠️ **押す前に見せる。** 見えないまま押すと、作家さまの売上から引かれる
   * ことに気づかないまま承認できてしまう。
   */
  clawbackBearer: z.enum(['platform', 'creator']),
});
export type AdminRefundRequestDetail = z.infer<typeof adminRefundRequestDetailSchema>;

export const refundRequestListQuerySchema = z.object({
  status: z.enum(REFUND_REQUEST_STATUS_VALUES).optional(),
  orderId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type RefundRequestListQuery = z.infer<typeof refundRequestListQuerySchema>;

export const refundRequestListResponseSchema = z.object({
  items: z.array(refundRequestSchema),
});
export type RefundRequestListResponse = z.infer<typeof refundRequestListResponseSchema>;

/* --- 購入者 -------------------------------------------------------------- */

/**
 * 購入者からの申し出。
 *
 * ⚠️ **金額を受け取らない。** どれだけ返るかは審査が決める。ここで
 * 打てるようにすると、その額が約束に見える。
 */
export const submitRefundRequestSchema = z.object({
  reason: z.enum(REFUND_REQUEST_REASON_VALUES),
  /** 経緯。⚠️ 文字として扱う（HTML にしない）。 */
  statement: z.string().trim().min(10).max(2000),
});
export type SubmitRefundRequest = z.infer<typeof submitRefundRequestSchema>;

/* --- 運営 ---------------------------------------------------------------- */

/** 運営が代理で申し出を起こす（電話・メールで受けたとき）。 */
export const openRefundRequestSchema = z.object({
  orderId: z.string().min(1),
  reason: z.enum(REFUND_REQUEST_REASON_VALUES),
  statement: z.string().trim().max(2000).optional(),
  note: z.string().trim().max(2000).optional(),
});
export type OpenRefundRequest = z.infer<typeof openRefundRequestSchema>;

/** 調べ終えた、という記録。⚠️ 承認ではない。 */
export const investigateRefundRequestSchema = z.object({
  note: z.string().trim().min(1).max(2000),
});
export type InvestigateRefundRequest = z.infer<typeof investigateRefundRequestSchema>;

/**
 * 作家さまへ事実確認を依頼する。
 *
 * ⚠️ **期限を画面から受け取らない。** 設定の営業日数から決める。
 * 打てるようにすると、急ぎのたびに短くなり、意味が無くなる。
 */
export const askCreatorSchema = z.object({
  note: z.string().trim().max(2000).optional(),
});
export type AskCreatorRequest = z.infer<typeof askCreatorSchema>;

/**
 * 承認する。
 *
 * ⚠️ **金額をもう一度打っていただく。** 一部返金の金額を受け取る口を
 * 開けた代わりの歯止め（`UD-104` の当初の判断を覆した条件）。画面に出て
 * いる額をそのまま通すのではなく、**打ち直して一致したときだけ**進む。
 */
export const approveRefundRequestSchema = z.object({
  /** 確認のための再入力。⚠️ 申請の額と一致しなければ通さない。 */
  amount: z.number().int().positive(),
  entitlementDisposition: z.enum(ENTITLEMENT_DISPOSITION_VALUES),
  /**
   * 原則対象外の事由を、例外として通す。
   *
   * ⚠️ **省略時は `false`。** 押し慣れで越えられるようにしない。
   */
  approveAsException: z.boolean().optional(),
  note: z.string().trim().max(2000).optional(),
});
export type ApproveRefundRequest = z.infer<typeof approveRefundRequestSchema>;

/** 却下する。⚠️ 理由が要る（空では通らない）。 */
export const rejectRefundRequestSchema = z.object({
  rejectionNote: z.string().trim().min(1).max(2000),
});
export type RejectRefundRequest = z.infer<typeof rejectRefundRequestSchema>;

/** 実行した結果。⚠️ **入金の完了ではない**（事業者が受け付けただけ）。 */
export const executeRefundRequestResponseSchema = z.object({
  request: refundRequestSchema,
  refundId: z.string(),
  amountRefunded: z.number().int(),
  revokedEntitlements: z.number().int(),
  cancelledMintJobs: z.number().int(),
  annotatedMintJobs: z.number().int(),
});
export type ExecuteRefundRequestResponse = z.infer<typeof executeRefundRequestResponseSchema>;

/* --- 作家さま ------------------------------------------------------------ */

/** 作家さまへ来ている事実確認。⚠️ その方の分だけ。 */
export const creatorRefundInquirySchema = z.object({
  requestId: z.string(),
  orderId: z.string(),
  /** ⚠️ 事由は見せる。金額と購入者は見せない。 */
  reason: z.enum(REFUND_REQUEST_REASON_VALUES),
  buyerStatement: z.string().nullable(),
  askedAt: z.string(),
  dueAt: z.string(),
  answeredAt: z.string().nullable(),
  answer: z.string().nullable(),
  expired: z.boolean(),
});
export type CreatorRefundInquiryDto = z.infer<typeof creatorRefundInquirySchema>;

export const creatorRefundInquiryListResponseSchema = z.object({
  items: z.array(creatorRefundInquirySchema),
});
export type CreatorRefundInquiryListResponse = z.infer<
  typeof creatorRefundInquiryListResponseSchema
>;

/**
 * 作家さまの回答。
 *
 * ⚠️ **「返金してよい / いけない」の欄を置かない。** 決めるのは運営で、
 * 作家さまに伺うのは**事実**である。可否の欄を置くと、答えが「反対」で
 * 埋まったときに、運営が返金しづらくなる。
 */
export const answerRefundInquirySchema = z.object({
  answer: z.string().trim().min(1).max(4000),
  /** 添付の保管庫の鍵。⚠️ URL ではない。 */
  attachmentKeys: z.array(z.string().min(1)).max(10).optional(),
});
export type AnswerRefundInquiryRequest = z.infer<typeof answerRefundInquirySchema>;

/* --- 売上からの戻し ------------------------------------------------------ */

export const RECEIVABLE_STATUS_VALUES = [
  'outstanding',
  'offset',
  'settled',
  'written_off',
] as const;

/**
 * 精算済みのあとに返金が起きた分。
 *
 * ⚠️ **金額を書き換える口は無い**（`SETTLEMENT_AND_REFUND.md` §4）。
 * 記録であって帳簿ではない。状態だけが動く。
 */
export const creatorReceivableSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  amount: z.number().int(),
  status: z.enum(RECEIVABLE_STATUS_VALUES),
  createdAt: z.string(),
  settledAt: z.string().nullable(),
});
export type CreatorReceivableDto = z.infer<typeof creatorReceivableSchema>;

export const creatorReceivableListResponseSchema = z.object({
  items: z.array(creatorReceivableSchema),
  /** 未解消の合計。⚠️ 次の精算から差し引かれる見込み額。 */
  outstandingAmount: z.number().int(),
});
export type CreatorReceivableListResponse = z.infer<typeof creatorReceivableListResponseSchema>;
