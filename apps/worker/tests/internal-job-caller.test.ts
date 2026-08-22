import { describe, expect, it, vi } from 'vitest';
import { createInternalJobCaller, SCHEDULED_INTERNAL_JOBS } from '../src/internal-job-caller';
import type { RunnerLogger } from '../src/runner';

function silentLogger(): RunnerLogger & { errors: Record<string, unknown>[] } {
  const errors: Record<string, unknown>[] = [];
  return {
    errors,
    info: () => undefined,
    warn: () => undefined,
    error: (payload) => {
      errors.push(payload);
    },
  };
}

interface Clock {
  advance(ms: number): void;
  now(): Date;
}

function clock(start = new Date('2026-08-22T00:00:00.000Z')): Clock {
  let current = start.getTime();
  return {
    advance: (ms) => {
      current += ms;
    },
    now: () => new Date(current),
  };
}

function okResponse(): Response {
  return new Response('{}', { status: 200 });
}

describe('内部ジョブを叩く', () => {
  it('初回はすぐ叩く', async () => {
    // ⚠️ 起動直後に待たせない。落ちたあとの取りこぼしを早く拾う。
    const fetchImpl = vi.fn(async () => okResponse());
    const job = createInternalJobCaller({
      baseUrl: 'https://api.example/api/v1/internal/jobs',
      token: 'x'.repeat(32),
      path: 'issue-entitlements',
      label: '受取権の発行',
      everyMs: 60_000,
      logger: silentLogger(),
      now: clock().now,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(job.runOnce()).resolves.toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('間隔より短いうちは叩かない', async () => {
    /*
      ⚠️ **worker の巡回は 5 秒。** 間隔を見ないと、日次でよい仕事を
         1 日に 17,000 回叩くことになる。
    */
    const fetchImpl = vi.fn(async () => okResponse());
    const time = clock();
    const job = createInternalJobCaller({
      baseUrl: 'https://api.example/api/v1/internal/jobs',
      token: 'x'.repeat(32),
      path: 'send-notifications',
      label: '知らせの送信',
      everyMs: 60_000,
      logger: silentLogger(),
      now: time.now,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await job.runOnce();
    time.advance(59_000);
    await expect(job.runOnce()).resolves.toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    time.advance(1_001);
    await job.runOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('合言葉をヘッダへ載せる', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const job = createInternalJobCaller({
      baseUrl: 'https://api.example/api/v1/internal/jobs',
      token: 'secret'.padEnd(32, 'y'),
      path: 'issue-entitlements',
      label: '受取権の発行',
      everyMs: 1000,
      logger: silentLogger(),
      now: clock().now,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await job.runOnce();
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const [url, init] = call;
    expect(url).toBe('https://api.example/api/v1/internal/jobs/issue-entitlements');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-internal-job-token']).toBe(
      'secret'.padEnd(32, 'y'),
    );
  });

  it('失敗しても間隔は進む（落ち続けている口を巡回のたびに叩かない）', async () => {
    /*
      ⚠️ **成功でしか進めない実装にすると、相手が復旧しかけたところへ
         巡回のたびに押し寄せる。** 数えるのは「試みた時刻」である。
    */
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 500 }));
    const time = clock();
    const logger = silentLogger();
    const job = createInternalJobCaller({
      baseUrl: 'https://api.example/api/v1/internal/jobs',
      token: 'x'.repeat(32),
      path: 'issue-entitlements',
      label: '受取権の発行',
      everyMs: 60_000,
      logger,
      now: time.now,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(job.runOnce()).resolves.toBe(0);
    time.advance(5_000);
    await job.runOnce();
    time.advance(5_000);
    await job.runOnce();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // ⚠️ 黙って飛ばさない。失敗は記録に残す。
    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0]).toMatchObject({ job: 'issue-entitlements', status: 500 });
  });

  it('失敗のログに応答の本文を載せない', async () => {
    /*
      ⚠️ **内部の口とはいえ、返るのは運用の数値である。** ログへ流すと、
         そこから先はこちらの管理が及ばない。
    */
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ orderIds: ['order-1'] }), { status: 500 }),
    );
    const logger = silentLogger();
    const job = createInternalJobCaller({
      baseUrl: 'https://api.example/api/v1/internal/jobs',
      token: 'x'.repeat(32),
      path: 'issue-entitlements',
      label: '受取権の発行',
      everyMs: 1000,
      logger,
      now: clock().now,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await job.runOnce();
    expect(JSON.stringify(logger.errors)).not.toContain('order-1');
  });

  it('例外の中身をログへ出さない', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.5:8080');
    });
    const logger = silentLogger();
    const job = createInternalJobCaller({
      baseUrl: 'https://api.example/api/v1/internal/jobs',
      token: 'x'.repeat(32),
      path: 'send-notifications',
      label: '知らせの送信',
      everyMs: 1000,
      logger,
      now: clock().now,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(job.runOnce()).resolves.toBe(0);
    expect(logger.errors).toHaveLength(1);
    // ⚠️ 接続先の姿は運用の秘密。名前と、打ち切りかどうかまで。
    expect(JSON.stringify(logger.errors)).not.toContain('10.0.0.5');
  });

  it('待ち続けない（打ち切る）', async () => {
    /*
      ⚠️ **待ち続けると、ほかの仕事まで止まる。** 巡回は 1 本ずつ順に
         走るので、1 つが返らないと後ろが全部詰まる。
    */
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    );
    const logger = silentLogger();
    const job = createInternalJobCaller({
      baseUrl: 'https://api.example/api/v1/internal/jobs',
      token: 'x'.repeat(32),
      path: 'issue-entitlements',
      label: '受取権の発行',
      everyMs: 1000,
      logger,
      now: clock().now,
      timeoutMs: 10,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(job.runOnce()).resolves.toBe(0);
    expect(logger.errors[0]).toMatchObject({ aborted: true });
  });
});

describe('受け持つ内部ジョブの一覧', () => {
  it('worker が直接掃く 2 つを含めない', () => {
    /*
      ⚠️ **`release-expired-reservations` と `deliver-entitlements` は
         worker が同じ待ち行列を直接掃いている。** ここからも叩くと、
         同じ仕事を 2 経路から呼ぶことになる。
    */
    const paths = SCHEDULED_INTERNAL_JOBS.map((job) => job.path);
    expect(paths).not.toContain('release-expired-reservations');
    expect(paths).not.toContain('deliver-entitlements');
  });

  it('残りの 5 本をすべて持つ', () => {
    // ⚠️ 数を書いておく。口を足したのに叩き手を足し忘れると、ここで気づく。
    const paths = SCHEDULED_INTERNAL_JOBS.map((job) => job.path);
    expect(paths).toEqual([
      'issue-entitlements',
      'reconcile-revocations',
      'send-notifications',
      'enqueue-legal-notices',
      'notify-operations-alerts',
    ]);
  });

  it('間隔が 0 や負にならない', () => {
    for (const job of SCHEDULED_INTERNAL_JOBS) {
      expect(job.everyMs).toBeGreaterThan(0);
    }
  });
});
