import { Prisma, type PrismaClient } from '../../generated/client';
import type {
  CreatorDirectoryPort,
  CreatorDirectoryQuery,
  CreatorDirectorySummary,
  RefundAggregate,
  SalesAggregate,
  SalesReportPeriod,
  SalesReportPort,
} from '@sengoku/domain';

/**
 * 運営の売上レポート（`UD-123` の一部）。
 *
 * ⚠️ **試し売り（`STAGING_FIXTURE`）を必ず除く。** 混ざると、会計へ渡す表に
 * 存在しない売上が載る。**除き忘れても画面は何も言わない**ので、ここで閉じる。
 *
 * ⚠️ **区切りは PostgreSQL 側で JST へ寄せる。** アプリ側で丸めると、
 * 集計の粒度ぶんだけ全行を持ち出すことになる。
 *
 * ⚠️ **`count`・`sum` は `bigint` で返る。** そのまま渡すと JSON にできない。
 * 境界で `Number` へ落とす（金額は円の整数で、桁あふれの心配は無い）。
 */
export class PrismaSalesReportRepository implements SalesReportPort {
  constructor(private readonly prisma: PrismaClient) {}

  async aggregateSales(period: SalesReportPeriod): Promise<readonly SalesAggregate[]> {
    const unit = period.granularity === 'monthly' ? 'month' : 'day';
    const rows = await this.prisma.$queryRaw<
      readonly {
        period_key: string;
        order_count: bigint;
        gross_amount: bigint;
        platform_fee_amount: bigint;
        creator_amount: bigint;
      }[]
    >(Prisma.sql`
      SELECT to_char(
               date_trunc(${unit}, "paid_at" AT TIME ZONE 'Asia/Tokyo'),
               ${period.granularity === 'monthly' ? 'YYYY-MM' : 'YYYY-MM-DD'}
             ) AS period_key,
             count(*)::bigint AS order_count,
             coalesce(sum("total_amount"), 0)::bigint AS gross_amount,
             coalesce(sum("platform_fee_amount"), 0)::bigint AS platform_fee_amount,
             coalesce(sum("creator_amount"), 0)::bigint AS creator_amount
        FROM "orders"
        -- ⚠️ 支払いが確定したものだけ。申し込んだだけの注文を売上に混ぜない。
       WHERE "paid_at" IS NOT NULL
         AND "payment_status" = 'succeeded'
        -- ⚠️ 試し売りを除く。会計へ渡す表に、存在しない売上を載せない。
         AND "source" <> 'STAGING_FIXTURE'
         AND "paid_at" >= ${period.from}
         AND "paid_at" < ${period.to}
       GROUP BY 1
    `);

    return rows.map((row) => ({
      periodKey: row.period_key,
      orderCount: Number(row.order_count),
      grossAmount: Number(row.gross_amount),
      platformFeeAmount: Number(row.platform_fee_amount),
      creatorAmount: Number(row.creator_amount),
    }));
  }

  /**
   * 返金を数える。
   *
   * ⚠️ **成立した返金だけ。** 申請中を引くと、返っていないお金を返したことに
   * してしまう。
   *
   * ⚠️ **数える日付は `settled_at`。** 注文の支払日で数えると、
   * **一度締めて会計へ渡した月が、翌月の返金で書き換わる**。
   */
  async aggregateRefunds(period: SalesReportPeriod): Promise<readonly RefundAggregate[]> {
    const unit = period.granularity === 'monthly' ? 'month' : 'day';
    const rows = await this.prisma.$queryRaw<
      readonly { period_key: string; refund_count: bigint; refunded_amount: bigint }[]
    >(Prisma.sql`
      SELECT to_char(
               date_trunc(${unit}, r."settled_at" AT TIME ZONE 'Asia/Tokyo'),
               ${period.granularity === 'monthly' ? 'YYYY-MM' : 'YYYY-MM-DD'}
             ) AS period_key,
             count(*)::bigint AS refund_count,
             coalesce(sum(r."amount"), 0)::bigint AS refunded_amount
        FROM "refunds" r
        JOIN "orders" o ON o."id" = r."order_id"
       WHERE r."status" = 'succeeded'
         AND r."settled_at" IS NOT NULL
         AND o."source" <> 'STAGING_FIXTURE'
         AND r."settled_at" >= ${period.from}
         AND r."settled_at" < ${period.to}
       GROUP BY 1
    `);

    return rows.map((row) => ({
      periodKey: row.period_key,
      refundCount: Number(row.refund_count),
      refundedAmount: Number(row.refunded_amount),
    }));
  }
}

/**
 * 運営が見る作家さまの一覧（`UD-124` の一部）。
 *
 * ⚠️ **ご連絡先もお振込先の値も返さない。** 前者は持っていない（`UD-503`）。
 * 後者は「預かってあるか」までで、読むのは別の口（`payout_account.view_full`
 * ＋ 監査）である。
 *
 * ⚠️ **「作家さま」の一覧を別の表で持たない。** 会員なら誰でも出品できる
 * （`UD-806`）ので、**作品を 1 つでも持つ方**が作家さまである。表を作ると、
 * 出品したのに一覧に出ない方が生まれる。
 */
export class PrismaCreatorDirectoryRepository implements CreatorDirectoryPort {
  constructor(private readonly prisma: PrismaClient) {}

  list(query: CreatorDirectoryQuery): Promise<readonly CreatorDirectorySummary[]> {
    const keyword = query.keyword?.trim() ?? '';
    return this.summarize({
      limit: query.limit,
      keyword: keyword === '' ? null : keyword,
      accountId: null,
    });
  }

  async find(accountId: string): Promise<CreatorDirectorySummary | null> {
    const rows = await this.summarize({ limit: 1, keyword: null, accountId });
    return rows[0] ?? null;
  }

  /**
   * 1 本の問い合わせで数える。
   *
   * ⚠️ **一覧を出してから 1 人ずつ数え直さない。** 人数ぶんの往復になる。
   *
   * ⚠️ **`LEFT JOIN` した集計を掛け合わせない。** 作品数と注文数を同じ
   * `JOIN` で数えると、互いの行数を掛けた値になる（いわゆる扇形結合）。
   * それぞれを副問い合わせで畳んでから繋ぐ。
   */
  private async summarize(input: {
    readonly limit: number;
    readonly keyword: string | null;
    readonly accountId: string | null;
  }): Promise<readonly CreatorDirectorySummary[]> {
    const rows = await this.prisma.$queryRaw<
      readonly {
        account_id: string;
        display_name: string | null;
        shop_name: string | null;
        status: string;
        artwork_count: bigint;
        active_listing_count: bigint;
        order_count: bigint;
        gross_amount: bigint;
        refunded_amount: bigint;
        last_sold_at: Date | null;
        sales_terms_accepted_at: Date | null;
        has_payout_account: boolean;
      }[]
    >(Prisma.sql`
      WITH creators AS (
        SELECT DISTINCT "creator_account_id" AS account_id FROM "artworks"
      ),
      artwork_stats AS (
        SELECT "creator_account_id" AS account_id, count(*)::bigint AS artwork_count
          FROM "artworks" GROUP BY 1
      ),
      listing_stats AS (
        SELECT a."creator_account_id" AS account_id, count(*)::bigint AS active_listing_count
          FROM "listings" l
          JOIN "artworks" a ON a."id" = l."artwork_id"
         WHERE l."status" = 'active'
         GROUP BY 1
      ),
      order_stats AS (
        SELECT "creator_account_id" AS account_id,
               count(*)::bigint AS order_count,
               coalesce(sum("total_amount"), 0)::bigint AS gross_amount,
               max("paid_at") AS last_sold_at
          FROM "orders"
         WHERE "paid_at" IS NOT NULL
           AND "payment_status" = 'succeeded'
           AND "source" <> 'STAGING_FIXTURE'
         GROUP BY 1
      ),
      refund_stats AS (
        SELECT o."creator_account_id" AS account_id,
               coalesce(sum(r."amount"), 0)::bigint AS refunded_amount
          FROM "refunds" r
          JOIN "orders" o ON o."id" = r."order_id"
         WHERE r."status" = 'succeeded'
           AND o."source" <> 'STAGING_FIXTURE'
         GROUP BY 1
      ),
      consent_stats AS (
        SELECT "account_id", max("consented_at") AS sales_terms_accepted_at
          FROM "legal_consents"
         WHERE "kind" = 'creator_terms'
         GROUP BY 1
      )
      SELECT c.account_id,
             acc."display_name" AS display_name,
             p."shop_name" AS shop_name,
             acc."status"::text AS status,
             coalesce(aw.artwork_count, 0) AS artwork_count,
             coalesce(ls.active_listing_count, 0) AS active_listing_count,
             coalesce(os.order_count, 0) AS order_count,
             coalesce(os.gross_amount, 0) AS gross_amount,
             coalesce(rs.refunded_amount, 0) AS refunded_amount,
             os.last_sold_at,
             cs.sales_terms_accepted_at,
             -- ⚠️ **預かってあるかだけ。** 値は 1 つも出さない。
             (pa."creator_account_id" IS NOT NULL) AS has_payout_account
        FROM creators c
        JOIN "accounts" acc ON acc."id" = c.account_id
        LEFT JOIN "creator_profiles" p ON p."account_id" = c.account_id
        LEFT JOIN artwork_stats aw ON aw.account_id = c.account_id
        LEFT JOIN listing_stats ls ON ls.account_id = c.account_id
        LEFT JOIN order_stats os ON os.account_id = c.account_id
        LEFT JOIN refund_stats rs ON rs.account_id = c.account_id
        LEFT JOIN consent_stats cs ON cs."account_id" = c.account_id
        LEFT JOIN "creator_payout_accounts" pa ON pa."creator_account_id" = c.account_id
       WHERE (${input.accountId}::uuid IS NULL OR c.account_id = ${input.accountId}::uuid)
         AND (
           ${input.keyword}::text IS NULL
           OR acc."display_name" ILIKE '%' || ${input.keyword} || '%'
           OR p."shop_name" ILIKE '%' || ${input.keyword} || '%'
         )
       -- ⚠️ 売上の多い順。並びを決めないと、開くたびに順番が変わる。
       ORDER BY coalesce(os.gross_amount, 0) DESC, c.account_id ASC
       LIMIT ${input.limit}
    `);

    return rows.map((row) => ({
      accountId: row.account_id,
      displayName: row.display_name,
      shopName: row.shop_name,
      status: row.status,
      artworkCount: Number(row.artwork_count),
      activeListingCount: Number(row.active_listing_count),
      orderCount: Number(row.order_count),
      grossAmount: Number(row.gross_amount),
      refundedAmount: Number(row.refunded_amount),
      lastSoldAt: row.last_sold_at,
      salesTermsAcceptedAt: row.sales_terms_accepted_at,
      hasPayoutAccount: row.has_payout_account,
    }));
  }
}
