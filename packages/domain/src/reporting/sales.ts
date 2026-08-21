/**
 * 運営の売上レポート（`UD-123` の一部・実装 2026-08-22）。
 *
 * **締めるためには、まず数えられなければならない。** 作家さまへお渡しする
 * 明細（P1-2）はあったが、**運営が自分の商いを日次・月次で見る口が無かった**。
 *
 * ⚠️ **ここに「入金額」は出てこない。** 決済事業者の手数料はこちらの記録に
 * 無く、入金との突合もまだできない。**差引を入金額と読ませない**——読ませると、
 * 合わない額の原因を探す先を間違える。
 *
 * ⚠️ **消費税の内訳を出さない**（`UD-401` 未決）。金額はすべて税込の合計で、
 * 内訳の欄そのものを作らない。**空欄があると、いつか誰かが埋める。**
 *
 * ⚠️ **ここに時計も DB も持たない。** 期間の切り方は呼び出し元が渡した
 * `now` から決める。持たせると、境目を試験で再現できなくなる。
 */

/** 日次か月次か。⚠️ 語彙を閉じる。増やすなら期間の作り方も一緒に書く。 */
export const SALES_REPORT_GRANULARITIES = ['daily', 'monthly'] as const;
export type SalesReportGranularity = (typeof SALES_REPORT_GRANULARITIES)[number];

/** 既定で遡る幅。⚠️ 全期間を既定にしない。開くたびに全表を舐めることになる。 */
export const SALES_REPORT_DEFAULT_DAYS = 30;
export const SALES_REPORT_DEFAULT_MONTHS = 12;

/** 一度に返す上限。⚠️ 上限そのものを画面へ伝える（黙って切らない）。 */
export const SALES_REPORT_MAX_ROWS = 400;

/**
 * 集計の 1 行。
 *
 * ⚠️ **売上と返金は、別の日付で数えている。**
 *  - 売上 … その注文の**支払いが確定した日**
 *  - 返金 … その返金が**成立した日**
 *
 * 揃えたほうが直感には合うが、揃えると**過去の月の数字が後から動く**。
 * 一度締めて会計へ渡した月が、翌月の返金で書き換わる状態を作らない。
 */
export interface SalesReportRow {
  /** `2026-08-21`（日次）または `2026-08`（月次）。⚠️ JST で切る。 */
  readonly periodKey: string;
  readonly orderCount: number;
  /** 税込の販売額の合計。⚠️ 内訳は持たない（`UD-401`）。 */
  readonly grossAmount: number;
  readonly platformFeeAmount: number;
  readonly creatorAmount: number;
  readonly refundCount: number;
  /** その期間に**成立した**返金の合計。⚠️ 正の数で持つ。 */
  readonly refundedAmount: number;
  /** `gross - refunded`。⚠️ **入金額ではない。** */
  readonly netAmount: number;
}

/** 集計の材料。⚠️ 2 つの表から別々に来る（上の注記のとおり日付が違う）。 */
export interface SalesAggregate {
  readonly periodKey: string;
  readonly orderCount: number;
  readonly grossAmount: number;
  readonly platformFeeAmount: number;
  readonly creatorAmount: number;
}

export interface RefundAggregate {
  readonly periodKey: string;
  readonly refundCount: number;
  readonly refundedAmount: number;
}

export interface SalesReportPeriod {
  readonly granularity: SalesReportGranularity;
  /** 含む。⚠️ JST の 0 時ちょうど。 */
  readonly from: Date;
  /** 含まない。⚠️ 「その日の終わり」を 23:59:59 で表さない。 */
  readonly to: Date;
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * 既定の期間を決める。
 *
 * ⚠️ **終わりは「明日の 0 時」。** 「今日の 0 時」までにすると、今日ぶんが
 * 出ない——**「今日はまだ 1 件も売れていない」と「今日は集計していない」**が
 * 見分けられなくなる。
 */
export function defaultSalesReportPeriod(
  granularity: SalesReportGranularity,
  now: Date,
): SalesReportPeriod {
  if (granularity === 'monthly') {
    const end = startOfJstMonth(addJstMonths(now, 1));
    return {
      granularity,
      from: startOfJstMonth(addJstMonths(now, -(SALES_REPORT_DEFAULT_MONTHS - 1))),
      to: end,
    };
  }
  const end = startOfJstDay(addDays(now, 1));
  return {
    granularity,
    from: startOfJstDay(addDays(now, -(SALES_REPORT_DEFAULT_DAYS - 1))),
    to: end,
  };
}

/**
 * 期間に含まれる区切りを、すべて並べる。
 *
 * ⚠️ **売れなかった期間も 0 の行として出す。** 抜かすと、
 * **「その日は売れなかった」のか「集計できていない」のか**が見分けられない。
 * 会計へ渡す表で、行が飛んでいるのはいちばん困る。
 */
export function salesReportPeriodKeys(period: SalesReportPeriod): readonly string[] {
  const keys: string[] = [];
  let cursor =
    period.granularity === 'monthly' ? startOfJstMonth(period.from) : startOfJstDay(period.from);
  while (cursor.getTime() < period.to.getTime() && keys.length < SALES_REPORT_MAX_ROWS) {
    keys.push(formatPeriodKey(cursor, period.granularity));
    cursor =
      period.granularity === 'monthly'
        ? startOfJstMonth(addJstMonths(cursor, 1))
        : startOfJstDay(addDays(cursor, 1));
  }
  return keys;
}

/**
 * 2 つの集計を、区切りごとに突き合わせる。
 *
 * ⚠️ **返金しかない区切りを落とさない。** 売れた日と返金の日は違う。
 * 売上の側だけで行を作ると、**返金だけがあった日が表から消える**。
 */
export function buildSalesReport(input: {
  readonly period: SalesReportPeriod;
  readonly sales: readonly SalesAggregate[];
  readonly refunds: readonly RefundAggregate[];
}): readonly SalesReportRow[] {
  const salesBy = new Map(input.sales.map((row) => [row.periodKey, row]));
  const refundsBy = new Map(input.refunds.map((row) => [row.periodKey, row]));

  return salesReportPeriodKeys(input.period).map((periodKey): SalesReportRow => {
    const sale = salesBy.get(periodKey);
    const refund = refundsBy.get(periodKey);
    const grossAmount = sale?.grossAmount ?? 0;
    const refundedAmount = refund?.refundedAmount ?? 0;
    return {
      periodKey,
      orderCount: sale?.orderCount ?? 0,
      grossAmount,
      platformFeeAmount: sale?.platformFeeAmount ?? 0,
      creatorAmount: sale?.creatorAmount ?? 0,
      refundCount: refund?.refundCount ?? 0,
      refundedAmount,
      // ⚠️ 整数のまま引く。金額に小数を持ち込まない。
      netAmount: grossAmount - refundedAmount,
    };
  });
}

/** 期間の合計。⚠️ 行の合計と必ず一致させる（画面で別々に数えない）。 */
export function salesReportTotals(
  rows: readonly SalesReportRow[],
): Omit<SalesReportRow, 'periodKey'> {
  return rows.reduce<Omit<SalesReportRow, 'periodKey'>>(
    (total, row) => ({
      orderCount: total.orderCount + row.orderCount,
      grossAmount: total.grossAmount + row.grossAmount,
      platformFeeAmount: total.platformFeeAmount + row.platformFeeAmount,
      creatorAmount: total.creatorAmount + row.creatorAmount,
      refundCount: total.refundCount + row.refundCount,
      refundedAmount: total.refundedAmount + row.refundedAmount,
      netAmount: total.netAmount + row.netAmount,
    }),
    {
      orderCount: 0,
      grossAmount: 0,
      platformFeeAmount: 0,
      creatorAmount: 0,
      refundCount: 0,
      refundedAmount: 0,
      netAmount: 0,
    },
  );
}

/**
 * CSV の見出し。
 *
 * ⚠️ **「入金額」という語を使わない。** 決済事業者の手数料を引く前の値で
 * あり、入金額ではない。会計へ渡す表で名前を間違えると、突合が始まらない。
 *
 * ⚠️ **消費税の欄を作らない**（`UD-401` 未決）。空欄はいつか埋められる。
 */
export const SALES_REPORT_CSV_COLUMNS = [
  '期間',
  '件数',
  '販売額（税込）',
  '手数料',
  '作家さま配分',
  '返金件数',
  '返金額',
  '差引（販売額−返金額）',
] as const;

export function toSalesReportCsvRows(
  rows: readonly SalesReportRow[],
): readonly (readonly string[])[] {
  return rows.map((row) => [
    row.periodKey,
    String(row.orderCount),
    String(row.grossAmount),
    String(row.platformFeeAmount),
    String(row.creatorAmount),
    String(row.refundCount),
    String(row.refundedAmount),
    String(row.netAmount),
  ]);
}

/** CSV 1 枚を組み立てる。⚠️ 区切りと囲みの規則を 1 か所に閉じ込める。 */
export function buildSalesReportCsv(rows: readonly (readonly string[])[]): string {
  const all = [[...SALES_REPORT_CSV_COLUMNS], ...rows.map((row) => [...row])];
  return all.map((row) => row.map(quote).join(',')).join('\r\n');
}

/** ⚠️ 常に囲む。囲む・囲まないを値で分けると、規則が読みにくくなる。 */
function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/* --- JST の区切り。⚠️ `Date` の地方時に頼らない（実行環境で変わる）。 --- */

export function formatPeriodKey(at: Date, granularity: SalesReportGranularity): string {
  const jst = new Date(at.getTime() + JST_OFFSET_MS);
  const year = String(jst.getUTCFullYear()).padStart(4, '0');
  const month = String(jst.getUTCMonth() + 1).padStart(2, '0');
  if (granularity === 'monthly') {
    return `${year}-${month}`;
  }
  return `${year}-${month}-${String(jst.getUTCDate()).padStart(2, '0')}`;
}

function startOfJstDay(at: Date): Date {
  const jst = new Date(at.getTime() + JST_OFFSET_MS);
  const utc = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate());
  return new Date(utc - JST_OFFSET_MS);
}

function startOfJstMonth(at: Date): Date {
  const jst = new Date(at.getTime() + JST_OFFSET_MS);
  const utc = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), 1);
  return new Date(utc - JST_OFFSET_MS);
}

function addDays(at: Date, days: number): Date {
  return new Date(at.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * 月を足す。
 *
 * ⚠️ **日をまたいで足さない。** 31 日に 1 か月を足すと処理系によって
 * 翌々月へ飛ぶ。月の 1 日へ寄せてから足す。
 */
function addJstMonths(at: Date, months: number): Date {
  const jst = new Date(at.getTime() + JST_OFFSET_MS);
  const utc = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth() + months, 1);
  return new Date(utc - JST_OFFSET_MS);
}
