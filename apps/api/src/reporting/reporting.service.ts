import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  buildSalesReport,
  buildSalesReportCsv,
  defaultSalesReportPeriod,
  salesReportTotals,
  toSalesReportCsvRows,
  type ClockPort,
  type CreatorDirectoryPort,
  type CreatorDirectorySummary,
  type CreatorProfilePort,
  type PayoutRepository,
  type SalesReportGranularity,
  type SalesReportPort,
  type SalesReportRow,
} from '@sengoku/domain';

/**
 * 運営が数字と作家さまを見る（`UD-123` / `UD-124` の一部）。
 *
 * ⚠️ **ここに「直す」口を置かない。** 売上も精算も、記録された値を読むだけ。
 * 数字を人が書き換える口は作らない（`SETTLEMENT_AND_REFUND.md` §4）。
 *
 * ⚠️ **ご連絡先とお振込先の値を、この経路へ載せない。** 前者は持っていない
 * （`UD-503`）。後者は精算の画面から別の口（権限＋監査）で読む。
 */

export const REPORTING_CONFIG = Symbol('sengoku:reporting-config');

export interface ReportingConfig {
  readonly sales: SalesReportPort;
  readonly creators: CreatorDirectoryPort;
  readonly profiles: CreatorProfilePort;
  readonly payouts: PayoutRepository;
  readonly clock: ClockPort;
}

/** 一覧で返す上限。⚠️ 黙って切らない——応答に上限を載せて画面へ伝える。 */
export const CREATOR_DIRECTORY_LIMIT = 100;
/** 詳細に載せる精算の件数。⚠️ 全部は載せない（入口であって台帳ではない）。 */
const PAYOUT_PREVIEW_LIMIT = 12;

@Injectable()
export class ReportingService {
  constructor(@Inject(REPORTING_CONFIG) private readonly config: ReportingConfig) {}

  /**
   * 売上を期間ごとに数える。
   *
   * ⚠️ **売上と返金を別々に取り、ドメインで突き合わせる。** 数える日付が
   * 違うため（売上は支払いが確定した日、返金は成立した日）。1 本の
   * 問い合わせにすると、どちらかへ寄せることになり過去の月が動く。
   */
  async salesReport(granularity: SalesReportGranularity): Promise<{
    readonly granularity: SalesReportGranularity;
    readonly from: Date;
    readonly to: Date;
    readonly rows: readonly SalesReportRow[];
    readonly totals: Omit<SalesReportRow, 'periodKey'>;
  }> {
    const period = defaultSalesReportPeriod(granularity, this.config.clock.now());
    const [sales, refunds] = await Promise.all([
      this.config.sales.aggregateSales(period),
      this.config.sales.aggregateRefunds(period),
    ]);
    const rows = buildSalesReport({ period, sales, refunds });
    return {
      granularity,
      from: period.from,
      to: period.to,
      rows,
      // ⚠️ 合計は行から作る。画面で別々に数えると必ずずれる。
      totals: salesReportTotals(rows),
    };
  }

  /**
   * CSV を組み立てる。
   *
   * ⚠️ **画面と同じ関数から作る。** 別々に組み立てると、画面と CSV で
   * 数字が食い違う——**どちらが正しいのか誰にも分からなくなる**。
   */
  async salesReportCsv(granularity: SalesReportGranularity): Promise<string> {
    const report = await this.salesReport(granularity);
    return buildSalesReportCsv(toSalesReportCsvRows(report.rows));
  }

  listCreators(keyword: string | undefined): Promise<readonly CreatorDirectorySummary[]> {
    return this.config.creators.list({ limit: CREATOR_DIRECTORY_LIMIT, keyword });
  }

  async creatorDetail(accountId: string): Promise<{
    readonly creator: CreatorDirectorySummary;
    readonly bio: string | null;
    readonly invoiceNumber: string | null;
    readonly payouts: readonly {
      readonly id: string;
      readonly periodKey: string;
      readonly status: string;
      readonly netAmount: number;
      readonly dueAt: Date;
    }[];
  }> {
    const creator = await this.config.creators.find(accountId);
    if (creator === null) {
      /*
        ⚠️ **「まだ作品が無い方」も、ここでは見つからない。** 作家さまの
           一覧は作品を持つ方から作っている（表を別に持たない）。会員の
           情報は顧客サポート（P1-1）の側で見る。
      */
      throw new NotFoundException();
    }

    const [profile, payouts] = await Promise.all([
      this.config.profiles.find(accountId),
      this.config.payouts.list({ creatorAccountId: accountId, limit: PAYOUT_PREVIEW_LIMIT }),
    ]);

    return {
      creator,
      bio: profile?.bio ?? null,
      invoiceNumber: profile?.invoiceNumber ?? null,
      payouts: payouts.map((payout) => ({
        id: payout.id,
        periodKey: payout.periodKey,
        status: payout.status,
        netAmount: payout.netAmount,
        dueAt: payout.dueAt,
      })),
    };
  }
}
