import { CONSISTENCY_CHECK_KEYS, OPERATIONS_SEVERITIES } from '@sengoku/domain';
import type { OperationsSeverity } from '@sengoku/domain';
import { z } from 'zod';

/**
 * 運営ダッシュボード（P0-6）の契約。
 *
 * ⚠️ **個人を特定できる項目を作らない。** ここは運営が広く開く画面で、
 * 置いたものはそのまま目に触れる。項目そのものが無ければ、実装側が
 * うっかり載せても型で落ちる。
 */

export const operationsIndicatorSchema = z.object({
  key: z.string(),
  label: z.string(),
  /** 数える対象が無い項目（最終受信日時など）は `null`。 */
  count: z.number().int().nullable(),
  severity: z.enum(OPERATIONS_SEVERITIES),
  /** ⚠️ 赤には必ず添える。「異常です」だけでは次の一手が分からない。 */
  action: z.string().nullable(),
});
export type OperationsIndicatorView = z.infer<typeof operationsIndicatorSchema>;

export const operationsDashboardResponseSchema = z.object({
  /** ⚠️ 一覧の先頭に出す、いちばん重い色。 */
  overall: z.enum(OPERATIONS_SEVERITIES),
  indicators: z.array(operationsIndicatorSchema),
  /** 決済事業者からの知らせの最終受信。⚠️ 表示のためだけに別途返す。 */
  lastWebhookReceivedAt: z.string().nullable(),
  generatedAt: z.string(),
});
export type OperationsDashboardResponse = z.infer<typeof operationsDashboardResponseSchema>;

export const consistencyFindingSchema = z.object({
  key: z.enum(CONSISTENCY_CHECK_KEYS),
  label: z.string(),
  count: z.number().int().nonnegative(),
  /** ⚠️ 全件ではなく手がかり。数千件で画面が固まらないように。 */
  sampleIds: z.array(z.string()),
  severity: z.enum(OPERATIONS_SEVERITIES),
  action: z.string(),
});
export type ConsistencyFindingView = z.infer<typeof consistencyFindingSchema>;

export const consistencyResponseSchema = z.object({
  overall: z.enum(OPERATIONS_SEVERITIES),
  /** ⚠️ 0 件のものも返す。「調べて 0 件だった」ことに値打ちがある。 */
  findings: z.array(consistencyFindingSchema),
  generatedAt: z.string(),
});
export type ConsistencyResponse = z.infer<typeof consistencyResponseSchema>;

/** 受取権の一覧。⚠️ 氏名・メールの項目は無い（`UD-503`）。 */
export const entitlementAdminSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  orderNumber: z.string(),
  artworkId: z.string(),
  artworkTitle: z.string(),
  serialNo: z.number().int().positive(),
  status: z.string(),
  walletDeliveryStatus: z.string(),
  claimedByCommonUserId: z.string().nullable(),
  claimedAt: z.string().nullable(),
  walletDeliveredAt: z.string().nullable(),
  createdAt: z.string(),
});
export type EntitlementAdminView = z.infer<typeof entitlementAdminSchema>;

export const entitlementAdminListResponseSchema = z.object({
  items: z.array(entitlementAdminSchema),
  nextCursor: z.string().nullable(),
});
export type EntitlementAdminListResponse = z.infer<typeof entitlementAdminListResponseSchema>;

export const entitlementAdminDetailSchema = entitlementAdminSchema.extend({
  orderLineId: z.string(),
  accountId: z.string(),
  /** ⚠️ 本文は含めない。 */
  deliveries: z.array(
    z.object({
      id: z.string(),
      eventId: z.string(),
      eventType: z.string(),
      status: z.string(),
      attemptCount: z.number().int().nonnegative(),
      lastErrorCode: z.string().nullable(),
      deliveredAt: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
});
export type EntitlementAdminDetailView = z.infer<typeof entitlementAdminDetailSchema>;

export const entitlementAdminQuerySchema = z.object({
  status: z.string().optional(),
  walletDeliveryStatus: z.string().optional(),
  orderId: z.string().uuid().optional(),
  accountId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});
export type EntitlementAdminQuery = z.infer<typeof entitlementAdminQuerySchema>;

/** 発行の再実行の結果。 */
export const retryIssuanceResponseSchema = z.object({
  issuedCount: z.number().int().nonnegative(),
  /** ⚠️ 何も起きなかったことを隠さない。 */
  alreadyComplete: z.boolean(),
});
export type RetryIssuanceResponse = z.infer<typeof retryIssuanceResponseSchema>;

/** その方ぶんの再配送の結果。 */
export const redeliverResponseSchema = z.object({
  pickedCount: z.number().int().nonnegative(),
  deliveredCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
});
export type RedeliverResponse = z.infer<typeof redeliverResponseSchema>;

/**
 * 深刻度。
 *
 * ⚠️ **`@sengoku/domain` から素通しする。** 画面は domain へ依存できない
 * （依存検査で止まる）ので、通り道はここしか無い。ここで別に定義すると、
 * 段の数がずれたときに画面だけ古いままになる。
 */
export { OPERATIONS_SEVERITIES };
export type { OperationsSeverity };
