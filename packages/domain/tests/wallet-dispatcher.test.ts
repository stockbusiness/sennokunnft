import { describe, expect, it } from 'vitest';
import {
  STALE_PROCESSING_MS,
  sweepWalletDeliveries,
  type DeliveryAttemptOutcome,
  type WalletDeliveryEnqueueInput,
  type WalletDeliveryFailureInput,
  type WalletDeliveryOutboxPort,
  type WalletDeliveryRecord,
  type WalletDeliverySenderPort,
} from '../src/index';

const NOW = new Date('2026-08-14T08:00:00.000Z');

class StubClock {
  constructor(private current = NOW) {}
  now(): Date {
    return new Date(this.current);
  }
}

type Row = {
  -readonly [K in keyof WalletDeliveryRecord]: WalletDeliveryRecord[K];
} & {
  nextRetryAt: Date;
  deliveredAt: Date | null;
  lastErrorCode: string | null;
};

/**
 * 行列の Fake。
 *
 * ⚠️ 本物の排他制御は再現できない。`FOR UPDATE SKIP LOCKED` が
 * 効いていることは PostgreSQL の結合テストで確かめる。
 * ここで見るのは「判定した結果を必ず書き戻すか」だけ。
 */
class FakeOutbox implements WalletDeliveryOutboxPort {
  readonly rows = new Map<string, Row>();
  reclaimed = 0;

  seed(row: Partial<Row> & { id: string }): Row {
    const full: Row = {
      eventId: `evt_${row.id}`,
      eventType: 'entitlement.granted',
      entitlementId: 'ent-1',
      targetSiteKey: 'ovew-wallet',
      payload: '{"event_version":"1.0"}',
      payloadHash: `sha256:${'a'.repeat(64)}`,
      status: 'PENDING',
      attemptCount: 0,
      maxAttempts: 5,
      correlationId: 'corr_0123456789',
      nextRetryAt: NOW,
      deliveredAt: null,
      lastErrorCode: null,
      ...row,
    };
    this.rows.set(full.id, full);
    return full;
  }

  enqueue(input: WalletDeliveryEnqueueInput): Promise<WalletDeliveryRecord> {
    return Promise.resolve(this.seed({ id: input.eventId, ...input, status: 'PENDING' }));
  }

  claimBatch(input: { limit: number; now: Date }): Promise<WalletDeliveryRecord[]> {
    const claimed: WalletDeliveryRecord[] = [];
    for (const row of this.rows.values()) {
      if (claimed.length >= input.limit) break;
      if (row.status !== 'PENDING' || row.nextRetryAt > input.now) continue;
      row.status = 'PROCESSING';
      row.attemptCount += 1;
      claimed.push({ ...row });
    }
    return Promise.resolve(claimed);
  }

  markDelivered(input: { id: string; now: Date }): Promise<boolean> {
    const row = this.rows.get(input.id);
    if (row === undefined || row.status !== 'PROCESSING') return Promise.resolve(false);
    row.status = 'DELIVERED';
    row.deliveredAt = input.now;
    return Promise.resolve(true);
  }

  recordFailure(input: WalletDeliveryFailureInput): Promise<boolean> {
    const row = this.rows.get(input.id);
    if (row === undefined || row.status !== 'PROCESSING') return Promise.resolve(false);
    row.status = input.status;
    row.nextRetryAt = input.nextRetryAt;
    row.lastErrorCode = input.errorCode;
    return Promise.resolve(true);
  }

  requeue(input: { id: string; now: Date }): Promise<boolean> {
    const row = this.rows.get(input.id);
    if (row === undefined || (row.status !== 'FAILED' && row.status !== 'DEAD')) {
      return Promise.resolve(false);
    }
    row.status = 'PENDING';
    row.attemptCount = 0;
    row.nextRetryAt = input.now;
    return Promise.resolve(true);
  }

  reclaimStale(): Promise<number> {
    this.reclaimed += 1;
    return Promise.resolve(0);
  }

  findByEventId(eventId: string): Promise<WalletDeliveryRecord | null> {
    for (const row of this.rows.values()) {
      if (row.eventId === eventId) return Promise.resolve({ ...row });
    }
    return Promise.resolve(null);
  }
}

class FakeSender implements WalletDeliverySenderPort {
  readonly sent: { eventId: string; correlationId: string; payload: string }[] = [];

  constructor(private readonly outcomes: DeliveryAttemptOutcome[]) {}

  send(input: {
    eventId: string;
    correlationId: string;
    payload: string;
  }): Promise<DeliveryAttemptOutcome> {
    this.sent.push(input);
    return Promise.resolve(this.outcomes.shift() ?? { kind: 'response', statusCode: 200 });
  }
}

describe('配送ワーカーの 1 巡', () => {
  it('2xx なら DELIVERED にする', async () => {
    const outbox = new FakeOutbox();
    outbox.seed({ id: 'a' });
    const sender = new FakeSender([{ kind: 'response', statusCode: 202 }]);

    const outcomes = await sweepWalletDeliveries({ outbox, sender, clock: new StubClock() }, 10);

    expect(outcomes).toHaveLength(1);
    expect(outbox.rows.get('a')?.status).toBe('DELIVERED');
    expect(outbox.rows.get('a')?.deliveredAt).toEqual(NOW);
  });

  it('再試行できる失敗は PENDING へ戻し、バックオフを入れる', async () => {
    const outbox = new FakeOutbox();
    outbox.seed({ id: 'a' });
    const sender = new FakeSender([{ kind: 'response', statusCode: 503 }]);

    await sweepWalletDeliveries({ outbox, sender, clock: new StubClock() }, 10);

    const row = outbox.rows.get('a');
    expect(row?.status).toBe('PENDING');
    expect(row?.lastErrorCode).toBe('http_503');
    // 1 回目の失敗なので 1 分後。
    expect(row?.nextRetryAt).toEqual(new Date(NOW.getTime() + 60_000));
  });

  it('再試行できない失敗は FAILED にし、すぐ拾わせない', async () => {
    const outbox = new FakeOutbox();
    outbox.seed({ id: 'a' });
    const sender = new FakeSender([{ kind: 'response', statusCode: 422 }]);

    await sweepWalletDeliveries({ outbox, sender, clock: new StubClock() }, 10);

    expect(outbox.rows.get('a')?.status).toBe('FAILED');
    expect(outbox.rows.get('a')?.lastErrorCode).toBe('http_422');
  });

  it('上限に達した再試行は DEAD にする', async () => {
    const outbox = new FakeOutbox();
    // 4 回試し済み。この巡回で 5 回目になる。
    outbox.seed({ id: 'a', attemptCount: 4, maxAttempts: 5 });
    const sender = new FakeSender([{ kind: 'timeout' }]);

    await sweepWalletDeliveries({ outbox, sender, clock: new StubClock() }, 10);

    expect(outbox.rows.get('a')?.status).toBe('DEAD');
  });

  it('DEAD になっても受取権を delivered にしない（§19）', async () => {
    const outbox = new FakeOutbox();
    outbox.seed({ id: 'a', attemptCount: 5, maxAttempts: 5 });
    const sender = new FakeSender([{ kind: 'network' }]);

    await sweepWalletDeliveries({ outbox, sender, clock: new StubClock() }, 10);

    expect(outbox.rows.get('a')?.status).toBe('DEAD');
    expect(outbox.rows.get('a')?.deliveredAt).toBeNull();
  });

  it('再試行でも同じ event_id を送る（§16）', async () => {
    const outbox = new FakeOutbox();
    outbox.seed({ id: 'a' });
    const clock = new StubClock();

    await sweepWalletDeliveries(
      { outbox, sender: new FakeSender([{ kind: 'timeout' }]), clock },
      10,
    );
    // バックオフ後を装って戻す。
    const row = outbox.rows.get('a');
    if (row !== undefined) row.nextRetryAt = NOW;

    const second = new FakeSender([{ kind: 'response', statusCode: 200 }]);
    await sweepWalletDeliveries({ outbox, sender: second, clock }, 10);

    expect(second.sent[0]?.eventId).toBe('evt_a');
  });

  it('送信アダプタが例外を投げても、行を PROCESSING のまま残さない', async () => {
    // ⚠️ 残すと、その行は次の巡回で拾われず、
    //    「送ったのか送っていないのか分からない行」が静かに溜まる。
    const outbox = new FakeOutbox();
    outbox.seed({ id: 'a' });
    const sender: WalletDeliverySenderPort = {
      send: () => Promise.reject(new Error('boom')),
    };

    await sweepWalletDeliveries({ outbox, sender, clock: new StubClock() }, 10);

    expect(outbox.rows.get('a')?.status).toBe('PENDING');
    expect(outbox.rows.get('a')?.lastErrorCode).toBe('network');
  });

  it('1 巡で扱う件数に上限を効かせる', async () => {
    const outbox = new FakeOutbox();
    for (const id of ['a', 'b', 'c']) outbox.seed({ id });
    const sender = new FakeSender([]);

    const outcomes = await sweepWalletDeliveries({ outbox, sender, clock: new StubClock() }, 2);

    expect(outcomes).toHaveLength(2);
  });

  it('巡回のたびに取り残しの回収を試みる', async () => {
    const outbox = new FakeOutbox();
    await sweepWalletDeliveries({ outbox, sender: new FakeSender([]), clock: new StubClock() }, 10);
    expect(outbox.reclaimed).toBe(1);
  });

  it('取り残しの判定時間は送信待ちの上限より十分長い', () => {
    // 短くすると、まだ応答を待っている行を別のワーカーが二重に送る。
    expect(STALE_PROCESSING_MS).toBeGreaterThan(60_000);
  });

  it('手動再送は FAILED / DEAD からのみ（§20）', async () => {
    const outbox = new FakeOutbox();
    outbox.seed({ id: 'dead', status: 'DEAD', attemptCount: 5 });
    outbox.seed({ id: 'processing', status: 'PROCESSING' });
    outbox.seed({ id: 'delivered', status: 'DELIVERED' });

    expect(await outbox.requeue({ id: 'dead', now: NOW })).toBe(true);
    expect(await outbox.requeue({ id: 'processing', now: NOW })).toBe(false);
    expect(await outbox.requeue({ id: 'delivered', now: NOW })).toBe(false);
    // event_id は変えない。変えると相手の冪等キーが変わる。
    expect(outbox.rows.get('dead')?.eventId).toBe('evt_dead');
  });
});
