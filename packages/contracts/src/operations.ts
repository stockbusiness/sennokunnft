import {
  CONSISTENCY_CHECK_KEYS,
  DISPUTE_REASONS,
  DISPUTE_STATUSES,
  DISPUTE_URGENCIES,
  OPERATIONS_SEVERITIES,
  RESERVED_COUNT_DRIFT_DIRECTIONS,
  RESERVED_COUNT_REPAIR_CAUSE_STATES,
  RESERVED_COUNT_REPAIR_REASON_MAX_LENGTH,
  RESERVED_COUNT_REPAIR_REASON_MIN_LENGTH,
  RESERVED_COUNT_REPAIR_RESOLUTION_MAX_LENGTH,
  RESERVED_COUNT_REPAIR_RESOLUTION_MIN_LENGTH,
} from '@sengoku/domain';
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

/**
 * カード会社との争い 1 件（2026-08-22）。
 *
 * ⚠️ **買った方を特定できる項目を置かない**（`UD-503`）。氏名・メール・
 * 住所は、この契約に**項目そのものが無い**。無ければ載せようがない。
 */
export const disputeAdminSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  orderNumber: z.string(),
  artworkTitleSnapshot: z.string(),
  provider: z.string(),
  /** 事業者が採番した識別子。⚠️ これで事業者の画面を引く。 */
  disputeRef: z.string(),
  status: z.enum(DISPUTE_STATUSES),
  reason: z.enum(DISPUTE_REASONS),
  /** 色を決めるための区分。⚠️ 状態とは別に持つ。 */
  urgency: z.enum(DISPUTE_URGENCIES),
  /** ⚠️ 争われている額。注文の総額と一致するとは限らない。 */
  amount: z.number().int(),
  orderTotalAmount: z.number().int(),
  currency: z.string(),
  openedAt: z.string(),
  /** 証拠の提出期限。⚠️ 過ぎると自動的に負ける。無いこともある。 */
  evidenceDueAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  /** 敗訴で作った返金があるか。⚠️ 返金そのものは注文の画面で見る。 */
  hasRefund: z.boolean(),
});
export type DisputeAdminView = z.infer<typeof disputeAdminSchema>;

export const disputeAdminListResponseSchema = z.object({
  items: z.array(disputeAdminSchema),
  /** ⚠️ **上限で切ったことを隠さない。** 全部見えていると読ませない。 */
  hasMore: z.boolean(),
  /** 「期限が近い」の境目（日）。⚠️ 画面が文言に使う。定数にしない。 */
  dueSoonDays: z.number().int().positive(),
});
export type DisputeAdminListResponse = z.infer<typeof disputeAdminListResponseSchema>;

export const disputeAdminQuerySchema = z.object({
  /** ⚠️ 既定は「決着していないもの」。決着した争いは探しに行くもの。 */
  state: z.enum(['open', 'closed', 'all']).default('open'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type DisputeAdminQuery = z.infer<typeof disputeAdminQuerySchema>;

/**
 * 押さえがずれた作品 1 件（`ADMIN_OPERATIONS_GAP.md` §I）。
 *
 * ⚠️ **買った方を特定できる項目を置かない**（`UD-503`）。注文の識別子と
 * 注文番号までで、氏名・メール・住所は**項目そのものが無い**。
 */
export const reservedCountDriftOrderSchema = z.object({
  orderId: z.string(),
  orderNumber: z.string(),
  orderStatus: z.string(),
  /** `reserved` / `consumed` の仮引当の数量の合計。 */
  heldQuantity: z.number().int(),
  /** その注文・その作品で発行済みの受取権の数。⚠️ 取り消したぶんも含む。 */
  issuedCount: z.number().int(),
  /** この注文がまだ押さえているはずの数。 */
  stillHeld: z.number().int(),
});

export const reservedCountDriftSchema = z.object({
  artworkId: z.string(),
  artworkTitle: z.string(),
  reservedCount: z.number().int(),
  expectedReservedCount: z.number().int(),
  /** ⚠️ 符号を保つ。多いのか少ないのかで起きることが違う。 */
  difference: z.number().int(),
  direction: z.enum(RESERVED_COUNT_DRIFT_DIRECTIONS),
  consequence: z.string(),
  orders: z.array(reservedCountDriftOrderSchema),
});
export type ReservedCountDriftAdminView = z.infer<typeof reservedCountDriftSchema>;

export const reservedCountDriftListResponseSchema = z.object({
  items: z.array(reservedCountDriftSchema),
  /** ⚠️ **上限で切ったことを隠さない。** 全部見えていると読ませない。 */
  hasMore: z.boolean(),
  generatedAt: z.string(),
});
export type ReservedCountDriftListResponse = z.infer<typeof reservedCountDriftListResponseSchema>;

export const reservedCountDriftQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ReservedCountDriftQuery = z.infer<typeof reservedCountDriftQuerySchema>;

/**
 * 押さえのずれを直す申し入れ（`ADMIN_OPERATIONS_GAP.md` §I・2026-08-24 決定）。
 *
 * ⚠️ **直す先の数を受け取らない。** 人が数字を選べる口にすると、決済
 * P0/P1 §9.3 が禁じる「在庫数と無関係な予約作成」になる。直す先は
 * サーバー側が仮引当と受取権から**計算で出す。**
 */
export const reservedCountRepairRequestSchema = z.object({
  /**
   * 画面が見ていた押さえの数。
   *
   * ⚠️ **これが要の歯止め。** 画面を開いてから押すまでに正常なご注文が
   * 入ると、古い数字で上書きして**逆にずれを作る。**サーバー側は掴んで
   * 読み直し、この値と違えば直さない。
   */
  observedReservedCount: z.number().int().nonnegative(),
  /** ⚠️ 空では押せない。中身は検められないが、一度手を止めさせる。 */
  reason: z
    .string()
    .trim()
    .min(RESERVED_COUNT_REPAIR_REASON_MIN_LENGTH)
    .max(RESERVED_COUNT_REPAIR_REASON_MAX_LENGTH),
  /**
   * 原因を突き止めたうえで直すのか、分からないまま急ぐのか。
   *
   * ⚠️ **`unknown` を選んでも押せる。** 押さえが足りない側はいま売り越しが
   * 起きうる状態で、原因究明が済むまで待たせるほうが危ない。そのかわり
   * **積み残しとして残り続ける。**
   */
  causeState: z.enum(RESERVED_COUNT_REPAIR_CAUSE_STATES),
});
export type ReservedCountRepairRequest = z.infer<typeof reservedCountRepairRequestSchema>;

/** 直した記録 1 件。⚠️ 買った方を特定できる項目を置かない（`UD-503`）。 */
export const reservedCountRepairSchema = z.object({
  id: z.string(),
  artworkId: z.string(),
  /** 直した時点の作品名。⚠️ 改題されても動かない。 */
  artworkTitle: z.string(),
  before: z.number().int(),
  after: z.number().int(),
  /** ⚠️ 符号を保つ。多かったのか足りなかったのか。 */
  difference: z.number().int(),
  direction: z.enum(RESERVED_COUNT_DRIFT_DIRECTIONS),
  reason: z.string(),
  causeState: z.enum(RESERVED_COUNT_REPAIR_CAUSE_STATES),
  /** ⚠️ 直す前の内訳。これが無いと後から原因を辿れない。 */
  snapshot: z.array(reservedCountDriftOrderSchema.omit({ stillHeld: true })),
  repairedByAccountId: z.string(),
  repairedAt: z.string(),
  resolvedAt: z.string().nullable(),
  resolvedByAccountId: z.string().nullable(),
  resolutionNote: z.string().nullable(),
});
export type ReservedCountRepairAdminView = z.infer<typeof reservedCountRepairSchema>;

export const reservedCountRepairListResponseSchema = z.object({
  items: z.array(reservedCountRepairSchema),
  /** ⚠️ **上限で切ったことを隠さない。** 全部見えていると読ませない。 */
  hasMore: z.boolean(),
  /** 原因未特定でまだ閉じていない件数。⚠️ 画面の見出しに使う。 */
  pendingCount: z.number().int().nonnegative(),
  generatedAt: z.string(),
});
export type ReservedCountRepairListResponse = z.infer<typeof reservedCountRepairListResponseSchema>;

export const reservedCountRepairQuerySchema = z.object({
  /** ⚠️ 既定は積み残しのみ。閉じたものは探しに行くもの。 */
  state: z.enum(['pending', 'all']).default('pending'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ReservedCountRepairQuery = z.infer<typeof reservedCountRepairQuerySchema>;

/**
 * 積み残しを閉じる申し入れ。
 *
 * ⚠️ **消す操作ではない。** 閉じるのは「原因が分かった」と言うこと。
 * 何が分かったのかを書けないなら、まだ閉じるときではない。
 */
export const reservedCountRepairResolveRequestSchema = z.object({
  note: z
    .string()
    .trim()
    .min(RESERVED_COUNT_REPAIR_RESOLUTION_MIN_LENGTH)
    .max(RESERVED_COUNT_REPAIR_RESOLUTION_MAX_LENGTH),
});
export type ReservedCountRepairResolveRequest = z.infer<
  typeof reservedCountRepairResolveRequestSchema
>;

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
/**
 * 争いの語彙も素通しする（2026-08-22）。
 *
 * ⚠️ **画面がここから読むためにある。** 画面は `@sengoku/domain` へ依存
 * できない（依存検査で止まる）。ここを通さずに画面側で並べ直すと、語彙が
 * 増えたときに**画面だけ古いまま**になり、知らない値が英語のまま表に出る。
 * 見出しが全件そろっているかは画面側の試験で確かめている。
 */
export { DISPUTE_STATUSES, DISPUTE_REASONS, DISPUTE_URGENCIES };
/**
 * 修復まわりの語彙と長さも素通しする（2026-08-24）。
 *
 * ⚠️ **画面がここから読むためにある。** 画面は `@sengoku/domain` へ依存
 * できない（依存検査で止まる）。文字数の下限を画面側で別に持つと、
 * **画面は通すのにサーバーが弾く**という一番わかりにくい形になる。
 */
export {
  RESERVED_COUNT_REPAIR_CAUSE_STATES,
  RESERVED_COUNT_REPAIR_REASON_MAX_LENGTH,
  RESERVED_COUNT_REPAIR_REASON_MIN_LENGTH,
  RESERVED_COUNT_REPAIR_RESOLUTION_MAX_LENGTH,
  RESERVED_COUNT_REPAIR_RESOLUTION_MIN_LENGTH,
};
export type { OperationsSeverity };
