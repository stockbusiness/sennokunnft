import { z } from 'zod';

/**
 * 作家さまへの精算（`UD-119`。決定 2026-08-20）。
 *
 * ⚠️ **金額を受け取る欄を作らない。** 合計も明細も、集計が決めた値だけ。
 * 人が金額を書き換える口を作らない決定（`SETTLEMENT_AND_REFUND.md` §4）が、
 * 契約の形として現れている。訂正は**次の期間での調整**として行う。
 */

export const PAYOUT_STATUS_VALUES = ['draft', 'confirmed', 'paid'] as const;

/** `2026-08` の形。⚠️ `Date` の解釈に任せない。 */
export const payoutPeriodKeySchema = z
  .string()
  .regex(/^\d{4}-\d{2}$/u, '締め月は 2026-08 の形で指定してください');

export const payoutSchema = z.object({
  id: z.string(),
  /** ⚠️ 氏名やメールではなくアカウントID。画面では短縮して出す。 */
  creatorAccountId: z.string(),
  periodKey: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  /** お支払いの期日。⚠️ 焼き付けた値。設定を変えても動かない。 */
  dueAt: z.string(),
  status: z.enum(PAYOUT_STATUS_VALUES),
  currency: z.string(),
  grossAmount: z.number().int(),
  feeAmount: z.number().int(),
  /** 差し戻した額。⚠️ 正の数。 */
  refundedAmount: z.number().int(),
  /** 前月からの繰越。⚠️ マイナスもありうる。 */
  carriedInAmount: z.number().int(),
  netAmount: z.number().int(),
  /** 翌月への繰越。⚠️ マイナスもありうる。 */
  carriedOutAmount: z.number().int(),
  /** ⚠️ **その時点の**設定。焼き付けてある。 */
  minimumPayoutAmount: z.number().int(),
  transferFeeBearer: z.enum(['creator', 'platform']),
  confirmedAt: z.string().nullable(),
  paidAt: z.string().nullable(),
  paidByAccountId: z.string().nullable(),
  lineCount: z.number().int(),
  createdAt: z.string(),
});
export type PayoutViewDto = z.infer<typeof payoutSchema>;

export const payoutLineSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  orderNumber: z.string(),
  /** ⚠️ 注文時点の作品名。マスタを引き直さない。 */
  artworkTitleSnapshot: z.string(),
  grossAmount: z.number().int(),
  feeRateBps: z.number().int(),
  feeAmount: z.number().int(),
  /** ⚠️ 差し戻しはマイナス。 */
  netAmount: z.number().int(),
  isClawback: z.boolean(),
});
export type PayoutLineViewDto = z.infer<typeof payoutLineSchema>;

export const payoutListResponseSchema = z.object({ items: z.array(payoutSchema) });
export type PayoutListResponse = z.infer<typeof payoutListResponseSchema>;

export const payoutDetailResponseSchema = z.object({
  payout: payoutSchema,
  lines: z.array(payoutLineSchema),
  /**
   * 返金の窓がまだ開いている注文の数。
   *
   * ⚠️ **0 でなければ確定できない**（`SETTLEMENT_AND_REFUND.md` §2-3）。
   * 画面はこれを見て「まだ締められない」ことを先に伝える。
   */
  openRefundWindows: z.number().int(),
});
export type PayoutDetailResponse = z.infer<typeof payoutDetailResponseSchema>;

/**
 * 締め（下書きの作成）。
 *
 * ⚠️ **作家さまを指定させない。** その期間に売上か繰越のある方を、
 * こちらで洗い出す。指定できると、指定し忘れた方がいつまでも支払われない。
 */
export const closePayoutPeriodRequestSchema = z.object({
  periodKey: payoutPeriodKeySchema,
});
export type ClosePayoutPeriodRequest = z.infer<typeof closePayoutPeriodRequestSchema>;

export const closePayoutPeriodResponseSchema = z.object({
  periodKey: z.string(),
  items: z.array(payoutSchema),
});
export type ClosePayoutPeriodResponse = z.infer<typeof closePayoutPeriodResponseSchema>;

export const payoutListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  periodKey: payoutPeriodKeySchema.optional(),
  creatorAccountId: z.string().optional(),
  status: z.enum(PAYOUT_STATUS_VALUES).optional(),
});
export type PayoutListQuery = z.infer<typeof payoutListQuerySchema>;
