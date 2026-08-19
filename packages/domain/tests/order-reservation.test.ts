import { describe, expect, it } from 'vitest';
import {
  canRelease,
  consumeReservationRecord,
  generateOrderNumber,
  isExpired,
  isOrderNumber,
  releaseReservationRecord,
  type RandomPort,
  type Reservation,
} from '../src/index';

const NOW = new Date('2026-08-19T12:00:00Z');

function reservation(overrides: Partial<Reservation> = {}): Reservation {
  return {
    id: 'rsv-1',
    orderId: 'ord-1',
    listingId: 'lst-1',
    quantity: 1,
    status: 'reserved',
    expiresAt: new Date(NOW.getTime() + 60_000),
    consumedAt: null,
    releasedAt: null,
    ...overrides,
  };
}

describe('予約の期限判定', () => {
  it('期限内は解放しない', () => {
    expect(canRelease(reservation(), NOW)).toBe(false);
    expect(isExpired(reservation(), NOW)).toBe(false);
  });

  it('期限ちょうどは解放してよい（境界）', () => {
    const target = reservation({ expiresAt: NOW });
    expect(canRelease(target, NOW)).toBe(true);
    expect(isExpired(target, NOW)).toBe(true);
  });

  it('期限を過ぎていれば解放してよい', () => {
    expect(canRelease(reservation({ expiresAt: new Date(NOW.getTime() - 1) }), NOW)).toBe(true);
  });

  /*
    ⚠️ **ここが本丸。** 解放済み・消費済みの行をもう一度解放すると、
       押さえていない在庫を戻すことになる。つまり**在庫が増える**。
       再実行しても二重解放しないのは、`reserved` だけを通すから。
  */
  it('解放済みの行は、期限を過ぎていても解放しない', () => {
    const past = new Date(NOW.getTime() - 60_000);
    expect(canRelease(reservation({ status: 'released', expiresAt: past }), NOW)).toBe(false);
  });

  it('消費済み（決済確定）の行は解放しない', () => {
    const past = new Date(NOW.getTime() - 60_000);
    expect(canRelease(reservation({ status: 'consumed', expiresAt: past }), NOW)).toBe(false);
  });
});

describe('予約の状態変更', () => {
  it('解放すると時刻が入る', () => {
    const result = releaseReservationRecord(reservation(), NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('released');
      expect(result.value.releasedAt).toEqual(NOW);
    }
  });

  it('二度目の解放は断る', () => {
    const result = releaseReservationRecord(reservation({ status: 'released' }), NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ORDER_TRANSITION_NOT_ALLOWED');
  });

  it('消費すると時刻が入る', () => {
    const result = consumeReservationRecord(reservation(), NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('consumed');
      expect(result.value.consumedAt).toEqual(NOW);
    }
  });

  it('解放済みを消費できない', () => {
    expect(consumeReservationRecord(reservation({ status: 'released' }), NOW).ok).toBe(false);
  });
});

describe('注文番号', () => {
  /** 決まった並びを返す乱数。⚠️ 試験用。実装は CSPRNG を使う。 */
  function fixedRandom(values: number[]): RandomPort {
    return { bytes: (length) => Uint8Array.from(Array.from({ length }, (_, i) => values[i] ?? 0)) };
  }

  it('日付が入り、決めた形になる', () => {
    const number = generateOrderNumber(NOW, fixedRandom([0, 1, 2, 3, 4, 5, 6, 7]));
    expect(number.startsWith('SNK-20260819-')).toBe(true);
    expect(isOrderNumber(number)).toBe(true);
  });

  /*
    ⚠️ **読み違えやすい字を使わない。** 電話で伝える場面がある。
       `0/O` や `1/I/L` が混ざると、伝え間違いで別の注文を触る。
  */
  it('紛らわしい字を使わない', () => {
    // 全バイト値を通しても、禁じた字が出ないこと。
    const all = Array.from({ length: 256 }, (_, i) => i);
    const number = generateOrderNumber(NOW, fixedRandom(all));
    const suffix = number.slice('SNK-20260819-'.length);
    for (const forbidden of ['0', 'O', '1', 'I', 'L']) {
      expect(suffix).not.toContain(forbidden);
    }
  });

  it('乱数が変われば番号も変わる', () => {
    const a = generateOrderNumber(NOW, fixedRandom([0, 0, 0, 0, 0, 0, 0, 0]));
    const b = generateOrderNumber(NOW, fixedRandom([1, 1, 1, 1, 1, 1, 1, 1]));
    expect(a).not.toBe(b);
  });

  it('形の違うものを注文番号と認めない', () => {
    expect(isOrderNumber('SNK-20260819-0000O000')).toBe(false);
    expect(isOrderNumber('ord-1')).toBe(false);
    expect(isOrderNumber('SNK-2026-ABCDEFGH')).toBe(false);
  });
});
