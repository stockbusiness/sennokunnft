import { z } from 'zod';

/**
 * 運営の売上レポートと作家さまの一覧（`UD-123` / `UD-124` の一部）。
 *
 * ⚠️ **消費税の欄を作らない**（`UD-401` 未決）。金額はすべて税込の合計で、
 * 内訳の欄そのものを置かない。**空欄があると、いつか誰かが埋める。**
 *
 * ⚠️ **「入金額」の欄も作らない。** 決済事業者の手数料はこちらの記録に無く、
 * 入金との突合もまだできない。差引を入金額と読ませない。
 */

export const SALES_REPORT_GRANULARITY_VALUES = ['daily', 'monthly'] as const;

export const salesReportQuerySchema = z.object({
  granularity: z.enum(SALES_REPORT_GRANULARITY_VALUES).default('daily'),
});
export type SalesReportQuery = z.infer<typeof salesReportQuerySchema>;

export const salesReportRowSchema = z.object({
  periodKey: z.string(),
  orderCount: z.number().int(),
  grossAmount: z.number().int(),
  platformFeeAmount: z.number().int(),
  creatorAmount: z.number().int(),
  refundCount: z.number().int(),
  refundedAmount: z.number().int(),
  /** ⚠️ **入金額ではない。** 決済事業者の手数料を引く前の値。 */
  netAmount: z.number().int(),
});
export type SalesReportRowDto = z.infer<typeof salesReportRowSchema>;

export const salesReportResponseSchema = z.object({
  granularity: z.enum(SALES_REPORT_GRANULARITY_VALUES),
  /** 期間の始まり（含む）。⚠️ ISO 8601。 */
  from: z.string(),
  /** 期間の終わり（**含まない**）。 */
  to: z.string(),
  /** ⚠️ 古い順。会計へ渡す表と同じ並びにする。 */
  rows: z.array(salesReportRowSchema),
  totals: salesReportRowSchema.omit({ periodKey: true }),
  currency: z.string(),
});
export type SalesReportResponse = z.infer<typeof salesReportResponseSchema>;

/* --- 作家さまの一覧（`UD-124` の一部）--- */

export const creatorDirectoryQuerySchema = z.object({
  keyword: z.string().trim().max(120).optional(),
});
export type CreatorDirectoryQueryDto = z.infer<typeof creatorDirectoryQuerySchema>;

export const creatorDirectoryRowSchema = z.object({
  accountId: z.string(),
  displayName: z.string().nullable(),
  shopName: z.string().nullable(),
  /** アカウントの状態。⚠️ 止まっている方も一覧から消さない。 */
  status: z.string(),
  artworkCount: z.number().int(),
  activeListingCount: z.number().int(),
  orderCount: z.number().int(),
  grossAmount: z.number().int(),
  refundedAmount: z.number().int(),
  lastSoldAt: z.string().nullable(),
  salesTermsAcceptedAt: z.string().nullable(),
  /**
   * お振込先を預かってあるか。
   *
   * ⚠️ **値ではない。** 銀行名も名義も番号も、この応答には無い。読むのは
   * 精算の画面から別の口（`payout_account.view_full` ＋ 監査）で行う。
   */
  hasPayoutAccount: z.boolean(),
});
export type CreatorDirectoryRow = z.infer<typeof creatorDirectoryRowSchema>;

export const creatorDirectoryResponseSchema = z.object({
  items: z.array(creatorDirectoryRowSchema),
  /** ⚠️ 返せる上限。**黙って切らない**——画面がそう伝える。 */
  limit: z.number().int(),
});
export type CreatorDirectoryResponse = z.infer<typeof creatorDirectoryResponseSchema>;

export const creatorDirectoryDetailResponseSchema = z.object({
  creator: creatorDirectoryRowSchema,
  bio: z.string().nullable(),
  invoiceNumber: z.string().nullable(),
  /** 直近の精算。⚠️ 金額の正は精算の画面（ここは入口）。 */
  payouts: z.array(
    z.object({
      id: z.string(),
      periodKey: z.string(),
      status: z.string(),
      netAmount: z.number().int(),
      dueAt: z.string(),
    }),
  ),
});
export type CreatorDirectoryDetailResponse = z.infer<typeof creatorDirectoryDetailResponseSchema>;
