import {
  ACCOUNT_HOLDER_MAX,
  BANK_NAME_MAX,
  BRANCH_NAME_MAX,
  CREATOR_SETUP_KEYS,
  PAYOUT_ACCOUNT_TYPES,
} from '@sengoku/domain';
import { z } from 'zod';

/**
 * 作家さま運営（P1-2）の契約。
 *
 * ⚠️ **買った方の情報を返す項目を作らない。** 作家さまに要るのは
 * 「何がいくつ売れたか」であって、「誰が買ったか」ではない。
 * 項目が無ければ、実装がうっかり載せても型で落ちる。
 */

/** 期間 1 つぶんの売上。⚠️ 締めた月も、締めていない月も同じ形。 */
export const creatorPeriodEarningsSchema = z.object({
  periodKey: z.string(),
  /** ⚠️ `estimate` は「まだ締めていない」。確定した額ではない。 */
  state: z.enum(['estimate', 'draft', 'confirmed', 'paid']),
  grossAmount: z.number().int(),
  feeAmount: z.number().int(),
  refundedAmount: z.number().int(),
  carriedInAmount: z.number().int(),
  netAmount: z.number().int(),
  carriedOutAmount: z.number().int(),
  minimumPayoutAmount: z.number().int(),
  dueAt: z.string(),
  /** ⚠️ 「なぜまだ確定しないのか」の答え。 */
  openRefundWindows: z.number().int().nonnegative(),
});
export type CreatorPeriodEarningsView = z.infer<typeof creatorPeriodEarningsSchema>;

/** 作品ごとの売れ行き。⚠️ 作品名は注文時点のもの。 */
export const artworkSalesSchema = z.object({
  artworkTitleSnapshot: z.string(),
  soldCount: z.number().int().nonnegative(),
  grossAmount: z.number().int(),
  feeAmount: z.number().int(),
  netAmount: z.number().int(),
  /** ⚠️ 売れた数から黙って引かない。別に出す。 */
  clawbackCount: z.number().int().nonnegative(),
});
export type ArtworkSalesView = z.infer<typeof artworkSalesSchema>;

/** 明細 1 行。⚠️ 買った方の情報は含まない。 */
export const creatorEarningsLineSchema = z.object({
  orderNumber: z.string(),
  artworkTitleSnapshot: z.string(),
  grossAmount: z.number().int(),
  feeRateBps: z.number().int(),
  feeAmount: z.number().int(),
  netAmount: z.number().int(),
  isClawback: z.boolean(),
});

export const creatorEarningsResponseSchema = z.object({
  /** いま進行中の期間の見込み。⚠️ 締めた精算と同じ計算で出す。 */
  current: creatorPeriodEarningsSchema,
  /** 締めた精算の履歴（新しい順）。 */
  history: z.array(creatorPeriodEarningsSchema),
  /** 進行中の期間の、作品ごとのまとめ。 */
  byArtwork: z.array(artworkSalesSchema),
  /**
   * 次回のお振込。
   *
   * ⚠️ **`null` は「お支払いの予定が無い」。** 最低支払額に満たないときや、
   * 売上が無いときがこれ。0 円の振込予定を出さない。
   */
  nextPayout: z
    .object({ periodKey: z.string(), amount: z.number().int(), dueAt: z.string() })
    .nullable(),
});
export type CreatorEarningsResponse = z.infer<typeof creatorEarningsResponseSchema>;

export const creatorEarningsDetailResponseSchema = z.object({
  period: creatorPeriodEarningsSchema,
  lines: z.array(creatorEarningsLineSchema),
  byArtwork: z.array(artworkSalesSchema),
});
export type CreatorEarningsDetailResponse = z.infer<typeof creatorEarningsDetailResponseSchema>;

/** SNS・Web サイト。⚠️ `https` のものだけ（サーバー側で検証）。 */
export const creatorLinkSchema = z.object({
  label: z.string().max(30),
  url: z.string().url(),
});

export const creatorProfileDetailSchema = z.object({
  /** 表示名（`accounts`）。⚠️ ここでは読むだけ。変えるのは別の口。 */
  displayName: z.string().nullable(),
  shopName: z.string().nullable(),
  bio: z.string().nullable(),
  links: z.array(creatorLinkSchema),
  /** 画像の公開URL。⚠️ 鍵ではなく URL を返す（画面がそのまま出せるように）。 */
  iconUrl: z.string().nullable(),
  coverUrl: z.string().nullable(),
  invoiceNumber: z.string().nullable(),
  /** 販売規約への同意。⚠️ `null` は未同意。 */
  salesTermsAcceptedAt: z.string().nullable(),
  /** 何が済んでいて、何が済んでいないか。⚠️ ここで「売らせない」判定はしない。 */
  setup: z.array(
    z.object({
      key: z.enum(CREATOR_SETUP_KEYS),
      label: z.string(),
      done: z.boolean(),
      required: z.boolean(),
      detail: z.string(),
    }),
  ),
});
export type CreatorProfileDetailView = z.infer<typeof creatorProfileDetailSchema>;

export const updateCreatorProfileDetailRequestSchema = z.object({
  shopName: z.string().max(60).nullable().default(null),
  bio: z.string().max(2000).nullable().default(null),
  links: z.array(creatorLinkSchema).max(5).default([]),
  invoiceNumber: z.string().nullable().default(null),
});

export const creatorEarningsQuerySchema = z.object({
  /** ⚠️ 省略なら進行中の期間。 */
  periodKey: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional(),
});

/**
 * お振込先（P1-3・`UD-124` 決定 2026-08-21）。
 *
 * ⚠️ **読み戻しに口座番号そのものを入れない。** 入れると、画面を開くたびに
 * 番号が経路へ流れる。出すのは**伏せた表記**まで。振込のために全体が要る
 * のは運営だけで、そこは別の口（権限＋監査つき）にしてある。
 *
 * ⚠️ **本人確認書類の項目は無い**（`UD-124`）。項目が無ければ、実装が
 * うっかり載せても型で落ちる。
 */
export const payoutAccountViewSchema = z.object({
  bankName: z.string(),
  branchName: z.string(),
  accountType: z.enum(PAYOUT_ACCOUNT_TYPES),
  /** `***4567`。⚠️ **ここから元へは戻せない。** */
  maskedAccountNumber: z.string(),
  accountHolderKana: z.string(),
  updatedAt: z.string(),
});
export type PayoutAccountView = z.infer<typeof payoutAccountViewSchema>;

/** ⚠️ `null` は「まだご登録がない」。 */
export const payoutAccountResponseSchema = z.object({
  account: payoutAccountViewSchema.nullable(),
});
export type PayoutAccountResponse = z.infer<typeof payoutAccountResponseSchema>;

export const savePayoutAccountRequestSchema = z.object({
  bankName: z.string().min(1).max(BANK_NAME_MAX),
  branchName: z.string().min(1).max(BRANCH_NAME_MAX),
  accountType: z.enum(PAYOUT_ACCOUNT_TYPES),
  /*
    ⚠️ **ここでは形を細かく見ない。** 空白やハイフンの落とし方、桁数の
       許容はドメインが持つ（`validatePayoutAccount`）。2 か所に書くと、
       片方だけ直したときに「画面は通るのに保存できない」が生まれる。
  */
  accountNumber: z.string().min(1).max(32),
  accountHolderKana: z.string().min(1).max(ACCOUNT_HOLDER_MAX),
});
