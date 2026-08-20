import { describe, expect, it } from 'vitest';
import type { IntegrationRepository, IntegrationSettings } from '@sengoku/domain';
import { createWalletDeliveryResolver } from '../src/wallet-delivery-config';
import { createWalletDeliveryJob } from '../src/wallet-delivery-job';

/**
 * 接続先と鍵の解決（要決定 03）。
 *
 * ⚠️ **この試験の主題は「止めたときに止まること」。**
 * 管理画面から止めたのに環境変数へ落ちて送り続ける、が最悪。
 * 事故を止める操作が効かないのがいちばん困る。
 */

const ENV_FALLBACK = {
  endpoint: 'https://env.example.com/holdings',
  keyId: 'env-key',
  secret: 'env-secret',
  timeoutMs: 10_000,
};

function settings(overrides: Partial<IntegrationSettings> = {}): IntegrationSettings {
  return {
    id: 'settings-1',
    service: 'ovew_wallet',
    environment: 'production',
    endpointUrl: 'https://db.example.com/holdings',
    keyId: 'db-key',
    apiVersion: null,
    timeoutMs: 8000,
    maxAttempts: 5,
    enabled: true,
    // 決済にだけ意味のある欄。Wallet では既定のまま使わない。
    payment: {
      apiVersion: null,
      checkoutSuccessUrl: null,
      checkoutCancelUrl: null,
      platformFeeRateBps: 0,
    },
    rowVersion: 1,
    ...overrides,
  };
}

/** 必要な 2 本だけを持つ最小の代替。ほかを呼んだら試験が落ちるようにしてある。 */
function repositoryWith(input: {
  readonly settings: IntegrationSettings | null;
  readonly secret?: string | null;
}): IntegrationRepository {
  return {
    findSettings: () => Promise.resolve(input.settings),
    revealForAdapter: () => Promise.resolve(input.secret ?? null),
  } as unknown as IntegrationRepository;
}

describe('接続先と鍵の解決', () => {
  it('管理画面に接続先が入っていれば、そちらを使う', async () => {
    const resolve = createWalletDeliveryResolver({
      integrations: repositoryWith({ settings: settings(), secret: 'db-secret' }),
      appEnvironment: 'production',
      fallback: ENV_FALLBACK,
    });

    const result = await resolve();

    expect(result).toEqual({
      ok: true,
      config: {
        endpoint: 'https://db.example.com/holdings',
        keyId: 'db-key',
        secret: 'db-secret',
        timeoutMs: 8000,
        source: 'database',
      },
    });
  });

  /*
    ⚠️ **ここが本丸。** 管理画面の「停止」が効かないと、
       事故を止める手段が無くなる。環境変数へ落ちてはいけない。
  */
  it('管理画面から止められていたら、環境変数へ落ちずに送らない', async () => {
    const resolve = createWalletDeliveryResolver({
      integrations: repositoryWith({
        settings: settings({ enabled: false }),
        secret: 'db-secret',
      }),
      appEnvironment: 'production',
      fallback: ENV_FALLBACK,
    });

    expect(await resolve()).toEqual({ ok: false, reason: 'disabled' });
  });

  /*
    ⚠️ **画面を開いただけで止まらないようにする。** 管理画面を開くと
       設定の行そのものは作られる（`ensureSettings`）。行の有無で
       判定すると、一度開いただけで配送が止まる。
  */
  it('行はあるが接続先が空なら、環境変数へ落ちる', async () => {
    const resolve = createWalletDeliveryResolver({
      integrations: repositoryWith({
        settings: settings({ endpointUrl: null, keyId: null, enabled: false }),
      }),
      appEnvironment: 'production',
      fallback: ENV_FALLBACK,
    });

    const result = await resolve();

    expect(result.ok).toBe(true);
    expect(result.ok && result.config.source).toBe('environment');
    expect(result.ok && result.config.endpoint).toBe(ENV_FALLBACK.endpoint);
  });

  it('暗号鍵が無い構成では、DB を見ずに環境変数を使う', async () => {
    const resolve = createWalletDeliveryResolver({
      integrations: null,
      appEnvironment: 'production',
      fallback: ENV_FALLBACK,
    });

    const result = await resolve();

    expect(result.ok && result.config.source).toBe('environment');
  });

  it('鍵IDが欠けていれば送らない', async () => {
    const resolve = createWalletDeliveryResolver({
      integrations: repositoryWith({
        settings: settings({ keyId: null }),
        secret: 'db-secret',
      }),
      appEnvironment: 'production',
      fallback: ENV_FALLBACK,
    });

    expect(await resolve()).toEqual({ ok: false, reason: 'incomplete' });
  });

  it('有効な資格情報が無ければ送らない', async () => {
    const resolve = createWalletDeliveryResolver({
      integrations: repositoryWith({ settings: settings(), secret: null }),
      appEnvironment: 'production',
      fallback: ENV_FALLBACK,
    });

    expect(await resolve()).toEqual({ ok: false, reason: 'incomplete' });
  });

  it('落ち先も無ければ送らない', async () => {
    const resolve = createWalletDeliveryResolver({
      integrations: repositoryWith({ settings: null }),
      appEnvironment: 'production',
      fallback: null,
    });

    expect(await resolve()).toEqual({ ok: false, reason: 'incomplete' });
  });
});

describe('解決できないときの巡回', () => {
  function loggerSpy() {
    const lines: Array<{ level: string; message: string }> = [];
    return {
      lines,
      info: (_p: Record<string, unknown>, message: string) =>
        lines.push({ level: 'info', message }),
      warn: (_p: Record<string, unknown>, message: string) =>
        lines.push({ level: 'warn', message }),
      error: (_p: Record<string, unknown>, message: string) =>
        lines.push({ level: 'error', message }),
    };
  }

  /*
    ⚠️ **行を掴む前に止める。** 掴んでから止めると、外部へ 1 通も
       送っていないのに試行回数だけが減り、設定を直す前に DEAD へ落ちる。
  */
  it('解決できないときは 1 行も掴まない', async () => {
    let claimed = 0;
    const outbox = {
      reclaimStale: () => {
        claimed += 1;
        return Promise.resolve(0);
      },
      claimBatch: () => {
        claimed += 1;
        return Promise.resolve([]);
      },
    } as never;

    const logger = loggerSpy();
    const job = createWalletDeliveryJob({
      outbox,
      clock: { now: () => new Date('2026-08-18T00:00:00.000Z') },
      resolve: () => Promise.resolve({ ok: false as const, reason: 'incomplete' as const }),
      createSender: () => {
        throw new Error('送信アダプタを作ってはいけない');
      },
      logger,
      batchSize: 10,
      eventTypes: ['entitlement.granted'],
    });

    expect(await job.runOnce()).toBe(0);
    expect(claimed).toBe(0);
    // ⚠️ 黙って 0 件を返さない。「送るものが無い」と区別できなくなる。
    expect(logger.lines.some((line) => line.level === 'error')).toBe(true);
  });

  it('止められているときは、事故ではないので warn で報せる', async () => {
    const logger = loggerSpy();
    const job = createWalletDeliveryJob({
      outbox: {} as never,
      clock: { now: () => new Date('2026-08-18T00:00:00.000Z') },
      resolve: () => Promise.resolve({ ok: false as const, reason: 'disabled' as const }),
      createSender: () => {
        throw new Error('送信アダプタを作ってはいけない');
      },
      logger,
      batchSize: 10,
      eventTypes: ['entitlement.granted'],
    });

    await job.runOnce();

    expect(logger.lines).toEqual([
      { level: 'warn', message: 'Wallet 配送は管理画面から停止されています' },
    ]);
  });
});
