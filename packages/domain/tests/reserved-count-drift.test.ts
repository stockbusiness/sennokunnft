import { describe, expect, it } from 'vitest';
import {
  buildReservedCountDriftViews,
  stillHeldQuantity,
  type ReservedCountDriftRecord,
} from '../src/index';

/**
 * 押さえがずれた作品の読み取りモデル（`ADMIN_OPERATIONS_GAP.md` §I）。
 *
 * ⚠️ **あるべき値の計算はここが正。** SQL 側は素の数を返すだけで、
 * 同じ算術を二箇所に書かない。片方だけ直すと画面と検知が食い違う。
 */

function record(overrides: Partial<ReservedCountDriftRecord> = {}): ReservedCountDriftRecord {
  return {
    artworkId: 'artwork-1',
    artworkTitle: '試験の作品',
    reservedCount: 0,
    orders: [],
    ...overrides,
  };
}

function order(heldQuantity: number, issuedCount: number) {
  return {
    orderId: `order-${String(heldQuantity)}-${String(issuedCount)}`,
    orderNumber: 'SG-0001',
    orderStatus: 'paid',
    heldQuantity,
    issuedCount,
  };
}

describe('stillHeldQuantity', () => {
  it('発行していなければ、数量ぶんそのまま押さえている', () => {
    expect(stillHeldQuantity(order(3, 0))).toBe(3);
  });

  it('発行したぶんは押さえから外れる（決定 A）', () => {
    expect(stillHeldQuantity(order(3, 1))).toBe(2);
  });

  it('発行済みが数量を上回っていても負にならない', () => {
    /*
      ⚠️ **負にすると、あるべき値を押し下げる。** ずれていない作品が
         ずれて見え、偽の赤が出る。
    */
    expect(stillHeldQuantity(order(1, 5))).toBe(0);
  });
});

describe('buildReservedCountDriftViews', () => {
  it('多く数えていれば over として、売り越しにならないことを添える', () => {
    const [view] = buildReservedCountDriftViews([
      record({ reservedCount: 5, orders: [order(1, 0)] }),
    ]);

    expect(view?.expectedReservedCount).toBe(1);
    expect(view?.difference).toBe(4);
    expect(view?.direction).toBe('over');
    expect(view?.consequence).toContain('売り越しにはなりません');
  });

  it('少なく数えていれば under として、売り越しの危険を伝える', () => {
    const [view] = buildReservedCountDriftViews([
      record({ reservedCount: 0, orders: [order(2, 0)] }),
    ]);

    expect(view?.expectedReservedCount).toBe(2);
    expect(view?.difference).toBe(-2);
    expect(view?.direction).toBe('under');
    expect(view?.consequence).toContain('売り越し');
  });

  it('注文ごとの「まだ押さえている数」を添える', () => {
    const [view] = buildReservedCountDriftViews([
      record({ reservedCount: 9, orders: [order(3, 1), order(2, 2)] }),
    ]);

    expect(view?.orders.map((row) => row.stillHeld)).toEqual([2, 0]);
    expect(view?.expectedReservedCount).toBe(2);
  });

  it('仮引当が 1 件も無ければ、あるべき数は 0', () => {
    const [view] = buildReservedCountDriftViews([record({ reservedCount: 1, orders: [] })]);

    expect(view?.expectedReservedCount).toBe(0);
    expect(view?.difference).toBe(1);
  });

  it('数え直して合っていれば返さない', () => {
    /*
      ⚠️ **調べているあいだに直ることがある**（解放ジョブが走った等）。
         合っているものを赤く出す理由はない。
    */
    const views = buildReservedCountDriftViews([
      record({ reservedCount: 2, orders: [order(3, 1)] }),
    ]);

    expect(views).toEqual([]);
  });

  it('作品名をそのまま渡す（識別子だけでは調べようがない）', () => {
    const [view] = buildReservedCountDriftViews([
      record({ artworkTitle: '雪の城', reservedCount: 1, orders: [] }),
    ]);

    expect(view?.artworkTitle).toBe('雪の城');
  });
});
