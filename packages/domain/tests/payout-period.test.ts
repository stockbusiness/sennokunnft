import { describe, expect, it } from 'vitest';
import {
  isPeriodClosed,
  parsePayoutPeriod,
  payoutDueAt,
  payoutPeriodContaining,
  payoutPeriodOf,
  previousPayoutPeriod,
} from '../src/settlement/period';

/**
 * 精算の締め期間（`UD-119`）。
 *
 * ⚠️ ここで守りたいのは 3 つ。
 *   1. **JST で締める。** UTC の月境界で切ると、月末の 9 時間ぶんの売上が
 *      前の月に入る。作家さまの手元の記録と合わなくなる。
 *   2. **月末を「30 日後」で近似しない。** 2 月と 8 月で意味が変わる。
 *   3. **年をまたぐ計算が壊れないこと。** 12 月の翌月は翌年の 1 月。
 */

describe('締め期間の境界（JST）', () => {
  it('8 月の期間は JST の 8/1 0 時から 9/1 0 時まで', () => {
    const period = payoutPeriodOf(2026, 8);
    // JST 8/1 00:00 は UTC 7/31 15:00。
    expect(period.startAt.toISOString()).toBe('2026-07-31T15:00:00.000Z');
    expect(period.endAt.toISOString()).toBe('2026-08-31T15:00:00.000Z');
  });

  it('12 月の翌月は翌年の 1 月', () => {
    const period = payoutPeriodOf(2026, 12);
    expect(period.endAt.toISOString()).toBe('2026-12-31T15:00:00.000Z');
  });

  it('2 月は 28 日（うるう年は 29 日）で終わる', () => {
    expect(payoutPeriodOf(2026, 2).endAt.toISOString()).toBe('2026-02-28T15:00:00.000Z');
    // 2028 はうるう年。
    expect(payoutPeriodOf(2028, 2).endAt.toISOString()).toBe('2028-02-29T15:00:00.000Z');
  });
});

describe('その時刻が属する締め期間', () => {
  it('JST の月末 23 時は、その月に入る', () => {
    /*
      ⚠️ **UTC で判定すると翌月になる。** JST 8/31 23:00 は UTC 8/31 14:00 で
         同じ月だが、JST 9/1 06:00 は UTC 8/31 21:00 で**別の月**になる。
         ここを間違えると、月初の売上が前月へ紛れ込む。
    */
    expect(payoutPeriodContaining(new Date('2026-08-31T14:00:00.000Z')).key).toBe('2026-08');
  });

  it('JST の月初 6 時は、新しい月に入る（UTC ではまだ前月）', () => {
    // JST 9/1 06:00 = UTC 8/31 21:00。
    expect(payoutPeriodContaining(new Date('2026-08-31T21:00:00.000Z')).key).toBe('2026-09');
  });

  it('境界のちょうどは新しい月', () => {
    expect(payoutPeriodContaining(new Date('2026-08-31T15:00:00.000Z')).key).toBe('2026-09');
    expect(payoutPeriodContaining(new Date('2026-08-31T14:59:59.999Z')).key).toBe('2026-08');
  });
});

describe('締めを迎えたか', () => {
  it('締めの瞬間より前は締められない', () => {
    // ⚠️ まだ売れる余地のある期間を締めると、その日の売上が漏れる。
    const period = payoutPeriodOf(2026, 8);
    expect(isPeriodClosed(period, new Date('2026-08-31T14:59:59.999Z'))).toBe(false);
    expect(isPeriodClosed(period, new Date('2026-08-31T15:00:00.000Z'))).toBe(true);
  });
});

describe('お支払いの期日', () => {
  it('翌月末払い（猶予 1 か月）', () => {
    const due = payoutDueAt(payoutPeriodOf(2026, 8), 1);
    // JST 9/30 23:59:59.999 = UTC 9/30 14:59:59.999。
    expect(due.toISOString()).toBe('2026-09-30T14:59:59.999Z');
  });

  it('猶予 0 なら締め月の末日', () => {
    expect(payoutDueAt(payoutPeriodOf(2026, 8), 0).toISOString()).toBe('2026-08-31T14:59:59.999Z');
  });

  it('年をまたいでも壊れない', () => {
    // 12 月締め・翌月末払い → 翌年 1 月末。
    expect(payoutDueAt(payoutPeriodOf(2026, 12), 1).toISOString()).toBe('2027-01-31T14:59:59.999Z');
  });

  it('月末の繰り上がりで日付が飛ばない', () => {
    /*
      ⚠️ `setMonth` に頼ると 1/31 の 1 か月後が 3/3 になる。年と月の整数で
         計算しているので、1 月締め・翌月末払いは必ず 2 月末になる。
    */
    expect(payoutDueAt(payoutPeriodOf(2026, 1), 1).toISOString()).toBe('2026-02-28T14:59:59.999Z');
  });
});

describe('ひとつ前の期間', () => {
  it('1 月の前は前年の 12 月', () => {
    expect(previousPayoutPeriod(payoutPeriodOf(2026, 1)).key).toBe('2025-12');
  });
});

describe('締め月の読み取り', () => {
  it('`2026-08` の形だけ受け付ける', () => {
    expect(parsePayoutPeriod('2026-08').ok).toBe(true);
    for (const bad of ['2026-8', '2026/08', '202608', '2026-13', '2026-00', '', 'abc']) {
      expect(parsePayoutPeriod(bad).ok).toBe(false);
    }
  });

  it('遠すぎる年を断る（打ち間違いを止める）', () => {
    expect(parsePayoutPeriod('1999-08').ok).toBe(false);
    expect(parsePayoutPeriod('2999-08').ok).toBe(false);
  });
});
