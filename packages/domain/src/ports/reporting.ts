import type { RefundAggregate, SalesAggregate, SalesReportPeriod } from '../reporting/sales';

/**
 * 運営の売上レポート（`UD-123` の一部）。
 *
 * ⚠️ **売上と返金を 1 本の問い合わせにまとめない。** 数える日付が違う
 * （売上は支払いが確定した日、返金は成立した日）。1 本にすると、
 * どちらかの日付へ寄せることになり、**過去の月の数字が動く**。
 *
 * ⚠️ **試し売り（`STAGING_FIXTURE`）の注文を混ぜない。** 実装側で必ず
 * 除くこと。混ざると、会計へ渡す表に存在しない売上が載る。
 */
export interface SalesReportPort {
  aggregateSales(period: SalesReportPeriod): Promise<readonly SalesAggregate[]>;
  aggregateRefunds(period: SalesReportPeriod): Promise<readonly RefundAggregate[]>;
}

/**
 * 運営が見る作家さまの一覧（`UD-124` の一部）。
 *
 * ⚠️ **お振込先の値をここへ載せない。** 載せるのは「預かってあるか」まで。
 * 読むのは別の口（`payout_account.view_full` ＋ 監査）である。
 *
 * ⚠️ **ご連絡先も載せない**（`UD-503`）。作家さまも購入者と同じで、
 * アドレスは持っていない。
 */
export interface CreatorDirectorySummary {
  readonly accountId: string;
  readonly displayName: string | null;
  readonly shopName: string | null;
  readonly status: string;
  readonly artworkCount: number;
  /** いま店先に並んでいる出品の数。⚠️ 作品数とは別物。 */
  readonly activeListingCount: number;
  readonly orderCount: number;
  /** 支払いが確定した注文の税込合計。⚠️ 申し込んだだけの注文を混ぜない。 */
  readonly grossAmount: number;
  /** 成立した返金の合計。⚠️ 正の数。 */
  readonly refundedAmount: number;
  readonly lastSoldAt: Date | null;
  /** 販売規約へ同意した日時。⚠️ `null` は「まだ同意していない」。 */
  readonly salesTermsAcceptedAt: Date | null;
  /** お振込先を預かってあるか。⚠️ **値ではない。** */
  readonly hasPayoutAccount: boolean;
}

export interface CreatorDirectoryQuery {
  readonly limit: number;
  /** 表示名・ショップ名の部分一致。⚠️ 空なら絞らない。 */
  readonly keyword?: string | undefined;
}

export interface CreatorDirectoryPort {
  list(query: CreatorDirectoryQuery): Promise<readonly CreatorDirectorySummary[]>;
  find(accountId: string): Promise<CreatorDirectorySummary | null>;
}
