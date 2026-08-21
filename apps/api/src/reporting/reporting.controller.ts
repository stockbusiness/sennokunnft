import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import {
  creatorDirectoryDetailResponseSchema,
  creatorDirectoryQuerySchema,
  creatorDirectoryResponseSchema,
  salesReportQuerySchema,
  salesReportResponseSchema,
  type CreatorDirectoryDetailResponse,
  type CreatorDirectoryResponse,
  type CreatorDirectoryRow,
  type SalesReportResponse,
} from '@sengoku/contracts';
import type { CreatorDirectorySummary } from '@sengoku/domain';
import { RequireAction } from '../auth/auth.guard';
import { parseOrThrow } from '../common/validation';
import { CREATOR_DIRECTORY_LIMIT, ReportingService } from './reporting.service';

/**
 * 運営の売上レポート（`UD-123` の一部）。
 *
 * ⚠️ **数字を受け取る口を置かない。** 集計が出した値だけを返す。訂正は
 * 元の記録（返金・精算）を直すことでしか起こらない。
 *
 * ⚠️ **消費税の内訳も「入金額」も返さない**（`UD-401` 未決／突合は未実装）。
 * 欄そのものを作らない。**空欄はいつか埋められる。**
 */
@Controller('api/v1/admin/sales-report')
export class AdminSalesReportController {
  constructor(private readonly reporting: ReportingService) {}

  /**
   * 期間ごとの集計。
   *
   * ⚠️ **`auditor` にも開く。** いくら売れていくら返したかは監査の対象
   * そのもの。誰が買ったかも何を買ったかも含まない。
   */
  @Get()
  @RequireAction('sales_report.view')
  async report(@Query() rawQuery: Record<string, unknown>): Promise<SalesReportResponse> {
    const query = parseOrThrow(salesReportQuerySchema, rawQuery);
    const report = await this.reporting.salesReport(query.granularity);
    return parseOrThrow(salesReportResponseSchema, {
      granularity: report.granularity,
      from: report.from.toISOString(),
      to: report.to.toISOString(),
      rows: report.rows.map((row) => ({ ...row })),
      totals: { ...report.totals },
      // ⚠️ 通貨を混ぜて集計しない。いまは 1 通貨だが、欄は残しておく。
      currency: 'JPY',
    });
  }

  /**
   * CSV で書き出す。
   *
   * ⚠️ **BOM を付ける。** 付けないと Excel が UTF-8 と判断せず、
   * 日本語の見出しが化ける。
   *
   * ⚠️ **画面と同じ関数から作る。** 別々に組み立てると、画面と CSV で
   * 数字が食い違い、どちらが正しいのか誰にも分からなくなる。
   */
  @Get('csv')
  @RequireAction('sales_report.view')
  @Header('content-type', 'text/csv; charset=utf-8')
  @Header('content-disposition', 'attachment; filename="sales-report.csv"')
  async csv(@Query() rawQuery: Record<string, unknown>): Promise<string> {
    const query = parseOrThrow(salesReportQuerySchema, rawQuery);
    const csv = await this.reporting.salesReportCsv(query.granularity);
    // ⚠️ 文字そのものを置かない（見えない文字は検査で弾かれる）。
    return `\uFEFF${csv}`;
  }
}

/**
 * 作家さまの一覧・詳細（`UD-124` の一部）。
 *
 * ⚠️ **止める口を置かない。** 作家さま単位で出品を止める操作は、
 * **止めたときに何が起きるか**（進行中の注文・発行待ちの受取権・精算）を
 * 決めてから作る。見る画面のついでに足さない。
 *
 * ⚠️ **お振込先の値もご連絡先も返さない。** 前者は精算の画面から別の口
 * （`payout_account.view_full` ＋ 監査）で読む。後者は持っていない（`UD-503`）。
 */
@Controller('api/v1/admin/creators')
export class AdminCreatorDirectoryController {
  constructor(private readonly reporting: ReportingService) {}

  @Get()
  @RequireAction('creator.view')
  async list(@Query() rawQuery: Record<string, unknown>): Promise<CreatorDirectoryResponse> {
    const query = parseOrThrow(creatorDirectoryQuerySchema, rawQuery);
    const items = await this.reporting.listCreators(query.keyword);
    return parseOrThrow(creatorDirectoryResponseSchema, {
      items: items.map(toRow),
      // ⚠️ 黙って切らない。上限を返し、画面がそう伝える。
      limit: CREATOR_DIRECTORY_LIMIT,
    });
  }

  @Get(':accountId')
  @RequireAction('creator.view')
  async detail(@Param('accountId') accountId: string): Promise<CreatorDirectoryDetailResponse> {
    const detail = await this.reporting.creatorDetail(accountId);
    return parseOrThrow(creatorDirectoryDetailResponseSchema, {
      creator: toRow(detail.creator),
      bio: detail.bio,
      invoiceNumber: detail.invoiceNumber,
      payouts: detail.payouts.map((payout) => ({
        ...payout,
        dueAt: payout.dueAt.toISOString(),
      })),
    });
  }
}

function toRow(summary: CreatorDirectorySummary): CreatorDirectoryRow {
  return {
    accountId: summary.accountId,
    displayName: summary.displayName,
    shopName: summary.shopName,
    status: summary.status,
    artworkCount: summary.artworkCount,
    activeListingCount: summary.activeListingCount,
    orderCount: summary.orderCount,
    grossAmount: summary.grossAmount,
    refundedAmount: summary.refundedAmount,
    lastSoldAt: summary.lastSoldAt?.toISOString() ?? null,
    salesTermsAcceptedAt: summary.salesTermsAcceptedAt?.toISOString() ?? null,
    hasPayoutAccount: summary.hasPayoutAccount,
  };
}
