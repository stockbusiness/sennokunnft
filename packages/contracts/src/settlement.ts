import { z } from 'zod';

/**
 * 返金と精算の設定（`UD-104` / `UD-119`。決定 2026-08-20）。
 *
 * ⚠️ **ここは「いま何を使うか」だけ。** 過去の記録の説明ではない。
 * 使った値は注文・返金・精算へ焼き付ける（`docs/SETTLEMENT_AND_REFUND.md` §1）。
 */

export const TRANSFER_FEE_BEARER_VALUES = ['creator', 'platform'] as const;

export const settlementSettingsSchema = z.object({
  /**
   * 返金を受け付ける日数（決済完了から）。
   *
   * ⚠️ **`0` は誤りではない。** 「返金を受け付けない」という設定である。
   * 金額と違い、ここでの `0` は「未設定」を意味しない。
   */
  refundWindowDays: z.number().int().min(0).max(180),
  /** 締めから支払いまでの月数。1 = 月末締め・翌月末払い。 */
  payoutOffsetMonths: z.number().int().min(0).max(6),
  /** 最低支払額（円）。未満は翌月へ繰り越す。 */
  minimumPayoutAmount: z.number().int().min(0).max(100_000),
  transferFeeBearer: z.enum(TRANSFER_FEE_BEARER_VALUES),
});
export type SettlementSettingsView = z.infer<typeof settlementSettingsSchema>;

/**
 * 設定の取得。
 *
 * ⚠️ **未設定なら `settings` が `null`。** 既定値を返さない。返すと、
 * 決めていないまま「決まっている」ように見える。
 */
export const settlementSettingsResponseSchema = z.object({
  settings: settlementSettingsSchema.nullable(),
});
export type SettlementSettingsResponse = z.infer<typeof settlementSettingsResponseSchema>;

/** 設定の書き換え。⚠️ オーナー限定＋監査に残す。 */
export const updateSettlementSettingsRequestSchema = settlementSettingsSchema;
export type UpdateSettlementSettingsRequest = z.infer<typeof updateSettlementSettingsRequestSchema>;
