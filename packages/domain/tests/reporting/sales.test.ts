import { describe, expect, it } from 'vitest';
import {
  buildSalesReport,
  buildSalesReportCsv,
  defaultSalesReportPeriod,
  formatPeriodKey,
  salesReportPeriodKeys,
  salesReportTotals,
  SALES_REPORT_CSV_COLUMNS,
  toSalesReportCsvRows,
  type SalesReportPeriod,
} from '../../src/reporting/sales';

/**
 * 運営の売上レポート（`UD-123` の一部）。
 *
 * ⚠️ **この組の主題は 4 つ。**
 *  1. 売れなかった期間も 0 の行として出ること（**行が飛ばない**）
 *  2. 返金しかない期間が消えないこと
 *  3. JST で切れていること（実行環境の地方時に依らない）
 *  4. 消費税の欄も「入金額」という語も無いこと（`UD-401` 未決）
 */

/** 2026-08-20 09:00 JST（= 00:00 UTC）。 */
const NOW = new Date('2026-08-20T00:00:00.000Z');

function dailyPeriod(fromKey: string, toKeyExclusive: string): SalesReportPeriod {
  return {
    granularity: 'daily',
    from: new Date(`${fromKey}T00:00:00.000+09:00`),
    to: new Date(`${toKeyExclusive}T00:00:00.000+09:00`),
  };
}

describe('期間の切り方', () => {
  /*
    ⚠️ **JST で切る。** UTC で切ると、日本時間の 8 時に売れた分が
       前日に計上される。会計の締めが 1 日ずれる。
  */
  it('JST の日付で区切る', () => {
    // 2026-08-20 08:59 JST = 2026-08-19 23:59 UTC。⚠️ JST ではまだ 20 日。
    expect(formatPeriodKey(new Date('2026-08-19T23:59:00.000Z'), 'daily')).toBe('2026-08-20');
    expect(formatPeriodKey(new Date('2026-08-19T14:59:00.000Z'), 'daily')).toBe('2026-08-19');
  });

  it('月次は年月まで', () => {
    expect(formatPeriodKey(new Date('2026-08-31T15:00:00.000Z'), 'monthly')).toBe('2026-09');
  });

  /*
    ⚠️ **終わりは「明日の 0 時」。** 今日の 0 時までにすると今日ぶんが出ず、
       「今日はまだ売れていない」と「今日は集計していない」が区別できない。
  */
  it('既定の期間に、今日が含まれる', () => {
    const period = defaultSalesReportPeriod('daily', NOW);
    expect(salesReportPeriodKeys(period)).toContain('2026-08-20');
    expect(salesReportPeriodKeys(period)).toHaveLength(30);
  });

  it('月次の既定は 12 か月ぶん。⚠️ 月末に翌々月へ飛ばない', () => {
    // 8/31 で試す。1 日へ寄せずに月を足すと 10 月へ飛ぶ処理系がある。
    const period = defaultSalesReportPeriod('monthly', new Date('2026-08-31T12:00:00.000Z'));
    const keys = salesReportPeriodKeys(period);
    expect(keys).toHaveLength(12);
    expect(keys[keys.length - 1]).toBe('2026-08');
    expect(keys[0]).toBe('2025-09');
  });
});

describe('行の組み立て', () => {
  /*
    ⚠️ **売れなかった日も 0 の行として出す。** 抜かすと、
       「その日は売れなかった」のか「集計できていない」のかが分からない。
  */
  it('売れなかった日を飛ばさない', () => {
    const rows = buildSalesReport({
      period: dailyPeriod('2026-08-18', '2026-08-21'),
      sales: [
        {
          periodKey: '2026-08-20',
          orderCount: 2,
          grossAmount: 24000,
          platformFeeAmount: 4800,
          creatorAmount: 19200,
        },
      ],
      refunds: [],
    });

    expect(rows.map((row) => row.periodKey)).toEqual(['2026-08-18', '2026-08-19', '2026-08-20']);
    expect(rows[0]).toMatchObject({ orderCount: 0, grossAmount: 0, netAmount: 0 });
    // ⚠️ 空振りでないことを確かめる（全部 0 なら、この試験は何も見ていない）。
    expect(rows[2]).toMatchObject({ orderCount: 2, grossAmount: 24000, netAmount: 24000 });
  });

  /*
    ⚠️ **返金しかない日を消さない。** 売れた日と返金の日は違う。
       売上の側だけで行を作ると、返金だけがあった日が表から消える。
  */
  it('返金しかない日も行になる', () => {
    const rows = buildSalesReport({
      period: dailyPeriod('2026-08-19', '2026-08-20'),
      sales: [],
      refunds: [{ periodKey: '2026-08-19', refundCount: 1, refundedAmount: 12000 }],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      periodKey: '2026-08-19',
      orderCount: 0,
      grossAmount: 0,
      refundCount: 1,
      refundedAmount: 12000,
      // ⚠️ マイナスを隠さない。返金だけの日は差引がマイナスになる。
      netAmount: -12000,
    });
  });

  it('合計は行の合計と一致する', () => {
    const rows = buildSalesReport({
      period: dailyPeriod('2026-08-19', '2026-08-21'),
      sales: [
        {
          periodKey: '2026-08-19',
          orderCount: 1,
          grossAmount: 12000,
          platformFeeAmount: 2400,
          creatorAmount: 9600,
        },
        {
          periodKey: '2026-08-20',
          orderCount: 3,
          grossAmount: 36000,
          platformFeeAmount: 7200,
          creatorAmount: 28800,
        },
      ],
      refunds: [{ periodKey: '2026-08-20', refundCount: 1, refundedAmount: 12000 }],
    });

    expect(salesReportTotals(rows)).toEqual({
      orderCount: 4,
      grossAmount: 48000,
      platformFeeAmount: 9600,
      creatorAmount: 38400,
      refundCount: 1,
      refundedAmount: 12000,
      netAmount: 36000,
    });
  });
});

describe('CSV', () => {
  /*
    ⚠️ **「入金額」という語を使わない。** 決済事業者の手数料を引く前の値で
       あって、入金額ではない。会計へ渡す表で名前を間違えると突合が始まらない。
    ⚠️ **消費税の欄を作らない**（`UD-401` 未決）。空欄はいつか埋められる。
  */
  it('入金額とも消費税とも書かない', () => {
    const header = SALES_REPORT_CSV_COLUMNS.join(',');
    expect(header).not.toContain('入金');
    expect(header).not.toContain('消費税');
    expect(header).toContain('差引（販売額−返金額）');
  });

  it('見出しと値を組み立てる', () => {
    const csv = buildSalesReportCsv(
      toSalesReportCsvRows([
        {
          periodKey: '2026-08-20',
          orderCount: 1,
          grossAmount: 12000,
          platformFeeAmount: 2400,
          creatorAmount: 9600,
          refundCount: 0,
          refundedAmount: 0,
          netAmount: 12000,
        },
      ]),
    );

    const lines = csv.split('\r\n');
    expect(lines[0]).toBe(SALES_REPORT_CSV_COLUMNS.map((name) => `"${name}"`).join(','));
    expect(lines[1]).toBe('"2026-08-20","1","12000","2400","9600","0","0","12000"');
  });
});
