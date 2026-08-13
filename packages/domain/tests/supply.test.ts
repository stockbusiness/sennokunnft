import { describe, expect, it } from 'vitest';
import {
  allocateSerialNumbers,
  availableSupply,
  commitReservation,
  releaseReservation,
  reserveSupply,
  type SupplyCounters,
} from '../src/index';

function counters(overrides: Partial<SupplyCounters> = {}): SupplyCounters {
  return { maxSupply: 10, reservedCount: 0, issuedCount: 0, ...overrides };
}

describe('在庫計算（TEST_STRATEGY §3.3）', () => {
  it('販売可能数 = 上限 - 仮引当 - 発行済み', () => {
    expect(availableSupply(counters({ reservedCount: 2, issuedCount: 3 }))).toBe(5);
  });

  it('販売可能数を超える仮引当を拒否する（S-2）', () => {
    const result = reserveSupply(counters({ reservedCount: 8, issuedCount: 1 }), 2);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('INSUFFICIENT_SUPPLY');
  });

  it('ちょうど売り切る仮引当は成功する（境界）', () => {
    const result = reserveSupply(counters({ reservedCount: 8, issuedCount: 1 }), 1);
    if (!result.ok) throw new Error('expected success');
    expect(availableSupply(result.value)).toBe(0);
  });

  it('0 以下の数量を拒否する', () => {
    expect(reserveSupply(counters(), 0).ok).toBe(false);
    expect(reserveSupply(counters(), -1).ok).toBe(false);
  });

  it('仮引当を解放すると販売可能数が戻る（S-3）', () => {
    const reserved = reserveSupply(counters(), 3);
    if (!reserved.ok) throw new Error('setup failed');
    const released = releaseReservation(reserved.value, 3);
    if (!released.ok) throw new Error('expected success');
    expect(released.value.reservedCount).toBe(0);
    expect(availableSupply(released.value)).toBe(10);
  });

  it('引当を超える解放を拒否する', () => {
    expect(releaseReservation(counters({ reservedCount: 1 }), 2).ok).toBe(false);
  });

  it('決済確定で reserved から issued へ移り、合計は変わらない（S-5）', () => {
    const reserved = reserveSupply(counters(), 4);
    if (!reserved.ok) throw new Error('setup failed');
    const before = reserved.value.reservedCount + reserved.value.issuedCount;

    const committed = commitReservation(reserved.value, 4);
    if (!committed.ok) throw new Error('expected success');

    expect(committed.value.reservedCount).toBe(0);
    expect(committed.value.issuedCount).toBe(4);
    expect(committed.value.reservedCount + committed.value.issuedCount).toBe(before);
  });

  it('仮引当のない確定を拒否する', () => {
    expect(commitReservation(counters(), 1).ok).toBe(false);
  });

  it('どの操作でも reserved + issued が上限を超えない', () => {
    let current = counters({ maxSupply: 3 });
    for (let i = 0; i < 3; i += 1) {
      const reserved = reserveSupply(current, 1);
      if (!reserved.ok) throw new Error('expected success');
      const committed = commitReservation(reserved.value, 1);
      if (!committed.ok) throw new Error('expected success');
      current = committed.value;
      expect(current.reservedCount + current.issuedCount).toBeLessThanOrEqual(current.maxSupply);
    }
    // 上限に達したらそれ以上引き当てられない。
    expect(reserveSupply(current, 1).ok).toBe(false);
  });
});

describe('シリアル番号の採番', () => {
  it('数量ぶんの連番を返す（1枚単位の受取権に対応）', () => {
    expect(allocateSerialNumbers(counters({ issuedCount: 0 }), 3)).toEqual([1, 2, 3]);
  });

  it('発行済みの続きから採番する', () => {
    expect(allocateSerialNumbers(counters({ issuedCount: 7 }), 2)).toEqual([8, 9]);
  });

  it('数量 1 なら 1 件だけ返す', () => {
    expect(allocateSerialNumbers(counters({ issuedCount: 4 }), 1)).toEqual([5]);
  });
});
