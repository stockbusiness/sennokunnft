import { describe, expect, it } from 'vitest';
import type { OrderRepository, ReleasedReservation } from '@sengoku/domain';
import { createReservationReleaseJob } from '../src/reservation-release-job';
import type { RunnerLogger } from '../src/runner';

const NOW = new Date('2026-08-19T01:00:00.000Z');

function stubLogger(): RunnerLogger & { readonly lines: { payload: Record<string, unknown>; message: string }[] } {
  const lines: { payload: Record<string, unknown>; message: string }[] = [];
  return {
    lines,
    info: (payload, message) => lines.push({ payload, message }),
    warn: (payload, message) => lines.push({ payload, message }),
    error: (payload, message) => lines.push({ payload, message }),
  };
}

function stubOrders(released: readonly ReleasedReservation[]): OrderRepository & {
  readonly calls: { now: Date; limit: number }[];
} {
  const calls: { now: Date; limit: number }[] = [];
  return {
    calls,
    createWithReservation: () => Promise.reject(new Error('not used')),
    findById: () => Promise.resolve(null),
    list: () => Promise.resolve({ items: [], nextCursor: null }),
    releaseExpiredReservations: (now, limit) => {
      calls.push({ now, limit });
      return Promise.resolve(released);
    },
  };
}

describe('期限切れお取り置きの解放ジョブ', () => {
  it('解放した件数を返す', async () => {
    const orders = stubOrders([
      { reservationId: 'r1', orderId: 'o1', artworkId: 'a1', quantity: 1 },
      { reservationId: 'r2', orderId: 'o2', artworkId: 'a1', quantity: 1 },
    ]);
    const job = createReservationReleaseJob({
      orders,
      logger: stubLogger(),
      now: () => NOW,
      batchSize: 50,
    });

    expect(await job.runOnce()).toBe(2);
    expect(orders.calls).toEqual([{ now: NOW, limit: 50 }]);
  });

  it('何も無ければログを出さない', async () => {
    // ⚠️ 空振りのたびに書くと、本当に見たい行が探せなくなる。
    const logger = stubLogger();
    const job = createReservationReleaseJob({
      orders: stubOrders([]),
      logger,
      now: () => NOW,
      batchSize: 50,
    });

    expect(await job.runOnce()).toBe(0);
    expect(logger.lines).toHaveLength(0);
  });

  it('ログに購入者・作品名・金額を出さない', async () => {
    const logger = stubLogger();
    const job = createReservationReleaseJob({
      orders: stubOrders([{ reservationId: 'r1', orderId: 'o1', artworkId: 'a1', quantity: 1 }]),
      logger,
      now: () => NOW,
      batchSize: 50,
    });

    await job.runOnce();

    expect(Object.keys(logger.lines[0]?.payload ?? {}).sort()).toEqual([
      'orderIds',
      'releasedCount',
    ]);
  });
});
