import { describe, expect, it } from 'vitest';
import {
  EMPTY_ORDER_SEARCH,
  hasSearchCriteria,
  normalizeOrderSearch,
} from '../src/order/search';

/**
 * 注文の検索条件（`UD-121`）。
 *
 * ⚠️ ここで守りたいのは「探せること」ではなく、
 * **「探せなかった理由が分かること」**である。矛盾した条件で 0 件を
 * 返すと、探し方が悪いのか本当に無いのかが利用者に区別できない。
 */
describe('normalizeOrderSearch', () => {
  it('条件が無ければ、絞り込みの無い検索になる（誤りではない）', () => {
    const result = normalizeOrderSearch({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(EMPTY_ORDER_SEARCH);
    expect(hasSearchCriteria(result.value)).toBe(false);
  });

  it('注文番号の完全一致を受け付ける', () => {
    const result = normalizeOrderSearch({ orderNumber: 'snk-20260819-abcdefgh' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // ⚠️ 大文字小文字は吸収する。読み上げを書き取る運用のため。
    expect(result.value.orderNumber).toEqual({ kind: 'exact', value: 'SNK-20260819-ABCDEFGH' });
  });

  it('末尾 8 文字だけでも探せる（電話で控えられるのはそこだけのため）', () => {
    const result = normalizeOrderSearch({ orderNumber: ' ABCDEFGH ' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.orderNumber).toEqual({ kind: 'suffix', value: 'ABCDEFGH' });
  });

  it('注文番号に使わない字（0・O・1・I・L）は受け付けない', () => {
    // ⚠️ 読み替えて「近い注文」を返さない。打ち間違いが
    //    別の実在する注文に化ける。
    const result = normalizeOrderSearch({ orderNumber: 'ABCDEFG0' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('ORDER_SEARCH_INVALID');
  });

  it('期間が逆なら 0 件ではなく誤りとして返す', () => {
    const result = normalizeOrderSearch({ createdFrom: '2026-08-19', createdTo: '2026-08-10' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('ORDER_SEARCH_INVALID');
  });

  it('金額の範囲が逆なら誤りとして返す', () => {
    const result = normalizeOrderSearch({ minTotalAmount: 5000, maxTotalAmount: 1000 });
    expect(result.ok).toBe(false);
  });

  it('金額に小数を受け付けない（金額は円の整数）', () => {
    const result = normalizeOrderSearch({ minTotalAmount: 1000.5 });
    expect(result.ok).toBe(false);
  });

  it('作品名は 1 文字では絞り込めないので受け付けない', () => {
    const result = normalizeOrderSearch({ artworkTitle: '花' });
    expect(result.ok).toBe(false);
  });

  /**
   * ⚠️ **この 3 件が UD-121 の肝である。**
   * 保存は UTC、運用は JST。日付だけで絞るとき、UTC で区切ると
   * JST の朝に届いた注文が「その日から」の検索から漏れる。
   */
  describe('日付の境界は JST で区切る', () => {
    it('「から」は JST のその日の 00:00（= UTC の前日 15:00）', () => {
      const result = normalizeOrderSearch({ createdFrom: '2026-08-19' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.createdFrom?.toISOString()).toBe('2026-08-18T15:00:00.000Z');
    });

    it('「まで」はその日の終わりを含む', () => {
      const result = normalizeOrderSearch({ createdTo: '2026-08-19' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.createdTo?.toISOString()).toBe('2026-08-19T14:59:59.999Z');
    });

    it('JST の朝 8 時の注文が「その日から」に入る（UTC 基準だと漏れる）', () => {
      // JST 2026-08-19 08:00 = UTC 2026-08-18 23:00
      const order = new Date('2026-08-18T23:00:00.000Z');
      const result = normalizeOrderSearch({ createdFrom: '2026-08-19', createdTo: '2026-08-19' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(order >= (result.value.createdFrom as Date)).toBe(true);
      expect(order <= (result.value.createdTo as Date)).toBe(true);
    });
  });

  it('存在しない日付（2月31日）を黙って繰り上げない', () => {
    // ⚠️ `Date.UTC` は 2/31 を 3/3 にする。受け入れると、
    //    打ち間違いが「別の期間の検索」になる。
    const result = normalizeOrderSearch({ createdFrom: '2026-02-31' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('ORDER_SEARCH_INVALID');
  });

  it('日付の形が違えば受け付けない', () => {
    expect(normalizeOrderSearch({ createdFrom: '2026/08/19' }).ok).toBe(false);
    expect(normalizeOrderSearch({ createdFrom: '2026-08-19T00:00:00Z' }).ok).toBe(false);
  });

  it('空文字は「指定なし」として扱う（空欄のまま送られてくるため）', () => {
    const result = normalizeOrderSearch({ orderNumber: '', artworkTitle: '', createdFrom: '' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(hasSearchCriteria(result.value)).toBe(false);
  });

  it('照合値を条件に持てる（平文は受け取らない）', () => {
    const result = normalizeOrderSearch({ emailHash: 'a'.repeat(64) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.emailHash).toBe('a'.repeat(64));
    expect(hasSearchCriteria(result.value)).toBe(true);
  });
});
