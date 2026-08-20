import { domainError, type DomainError } from '../shared/errors';
import { err, ok, type Result } from '../shared/result';

/**
 * 精算の締め期間（`UD-119`。決定 2026-08-20）。
 *
 * ⚠️ **JST で締める。保存は UTC。** 日本時間の 9 月 1 日 0 時は UTC では
 * 8 月 31 日 15 時である。UTC の月境界で切ると、**月末の 9 時間ぶんの
 * 売上が前の月に入る**。作家さまの手元の記録と合わなくなり、
 * 「8 月の売上が足りない」という問い合わせになる。
 *
 * ⚠️ **`Date` の月計算に頼らない。** `setMonth` は月末の繰り上がりで
 * 意図しない日付になる（1/31 の 1 か月後が 3/3 になる）。年と月の整数で
 * 計算してから `Date.UTC` へ渡す。
 */

/** 日本時間と UTC の差（分）。⚠️ 日本に夏時間は無いので固定でよい。 */
const JST_OFFSET_MINUTES = 9 * 60;

/** 締め期間。⚠️ 開始は含み、終了は含まない（半開区間）。 */
export interface PayoutPeriod {
  /** 締め月。`2026-08` の形。⚠️ 表示にも識別にも使う。 */
  readonly key: string;
  readonly year: number;
  /** 1〜12。⚠️ `Date` の 0 始まりに合わせない。読み違いのもとになる。 */
  readonly month: number;
  /** JST の月初 0 時（UTC で保存する値）。 */
  readonly startAt: Date;
  /** 翌月の JST 月初 0 時。⚠️ **この時刻は含まない**。 */
  readonly endAt: Date;
}

/**
 * `2026-08` の形の文字列から締め期間を作る。
 *
 * ⚠️ **`Date` の解釈に任せない。** `new Date('2026-08')` は環境によって
 * UTC とローカルのどちらで読むかが変わる。桁を自分で取り出す。
 */
export function parsePayoutPeriod(key: string): Result<PayoutPeriod, DomainError> {
  const matched = /^(\d{4})-(\d{2})$/u.exec(key);
  if (matched === null) {
    return err(domainError('PAYOUT_PERIOD_INVALID', 'period must look like 2026-08'));
  }
  const year = Number.parseInt(matched[1] ?? '', 10);
  const month = Number.parseInt(matched[2] ?? '', 10);
  if (month < 1 || month > 12) {
    return err(domainError('PAYOUT_PERIOD_INVALID', 'month is out of range'));
  }
  // ⚠️ 締めの表を何十年も作らせない。打ち間違いを止めるための範囲。
  if (year < 2020 || year > 2100) {
    return err(domainError('PAYOUT_PERIOD_INVALID', 'year is out of range'));
  }
  return ok(payoutPeriodOf(year, month));
}

/** 年と月から締め期間を作る。⚠️ `month` は 1〜12。 */
export function payoutPeriodOf(year: number, month: number): PayoutPeriod {
  return {
    key: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`,
    year,
    month,
    startAt: jstMonthStart(year, month),
    endAt: jstMonthStart(...nextMonth(year, month)),
  };
}

/**
 * その時刻が属する締め期間（JST で判定）。
 *
 * ⚠️ **UTC の月で判定しない。** 8/31 18:00 JST は UTC では 8/31 09:00 で
 * 同じ月だが、9/1 06:00 JST は UTC では 8/31 21:00 で**別の月**になる。
 */
export function payoutPeriodContaining(instant: Date): PayoutPeriod {
  const shifted = new Date(instant.getTime() + JST_OFFSET_MINUTES * 60_000);
  return payoutPeriodOf(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1);
}

/** ひとつ前の締め期間。⚠️ 繰越を引き継ぐときに使う。 */
export function previousPayoutPeriod(period: PayoutPeriod): PayoutPeriod {
  const month = period.month === 1 ? 12 : period.month - 1;
  const year = period.month === 1 ? period.year - 1 : period.year;
  return payoutPeriodOf(year, month);
}

/**
 * お支払いの期日（JST の月末 23:59:59.999）。
 *
 * `payoutOffsetMonths` が 1 なら「月末締め・翌月末払い」。
 *
 * ⚠️ **月末を「30 日後」で近似しない。** 2 月と 8 月で意味が変わる。
 * 翌月の 1 日 0 時から 1 ミリ秒引いて、その月の最終瞬間を取る。
 */
export function payoutDueAt(period: PayoutPeriod, payoutOffsetMonths: number): Date {
  let [year, month] = [period.year, period.month];
  for (let i = 0; i < payoutOffsetMonths; i += 1) {
    [year, month] = nextMonth(year, month);
  }
  // その月の最終瞬間 = 翌月の月初 - 1ms。
  const [nextYear, nextMonthValue] = nextMonth(year, month);
  return new Date(jstMonthStart(nextYear, nextMonthValue).getTime() - 1);
}

/**
 * 締めを迎えているか。
 *
 * ⚠️ **締めの当日には作らせない。** `endAt` は「翌月の 1 日 0 時」なので、
 * その瞬間より前に集計すると、まだ売れる余地のある期間を締めることになる。
 */
export function isPeriodClosed(period: PayoutPeriod, now: Date): boolean {
  return now.getTime() >= period.endAt.getTime();
}

/** JST の月初 0 時を UTC の `Date` として返す。 */
function jstMonthStart(year: number, month: number): Date {
  return new Date(Date.UTC(year, month - 1, 1) - JST_OFFSET_MINUTES * 60_000);
}

/** 翌月の [年, 月]。⚠️ `Date` を経由しない（月末の繰り上がりを避ける）。 */
function nextMonth(year: number, month: number): readonly [number, number] {
  return month === 12 ? [year + 1, 1] : [year, month + 1];
}
