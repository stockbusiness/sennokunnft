import { describe, expect, it, vi } from 'vitest';
import { classifyProbe } from '@sengoku/domain';
import { ReachabilityProbe } from '../src/reachability-probe';

/**
 * 接続先へ届くかどうかの確認（指示書 §4.3・要決定 06）。
 *
 * ⚠️ **この試験の主題は「何を送らないか」。** 相手は受取権を作る口で、
 * こちらの都合で試し打ちしてよい相手ではない。本文も署名も送らないこと、
 * リダイレクトを追わないことを固定する。
 */
const clock = { now: (): Date => new Date('2026-08-18T00:00:00.000Z') };

function probeWith(impl: typeof fetch): ReachabilityProbe {
  return new ReachabilityProbe({ clock, timeoutMs: 5000, fetchImpl: impl });
}

describe('到達性の確認', () => {
  it('本文も署名も送らず、OPTIONS で尋ねる', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fake = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push([String(url), init]);
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    await probeWith(fake).probe('https://wallet.example.com/v1/holdings');

    const [url, init] = calls[0] ?? [];
    expect(url).toBe('https://wallet.example.com/v1/holdings');
    expect(init?.method).toBe('OPTIONS');
    // ⚠️ 本文を持たせない。相手に何も起こさせないため。
    expect(init?.body).toBeUndefined();
    // ⚠️ 署名ヘッダを付けない。資格情報まで確かめられる顔をしないため。
    expect(init?.headers).toBeUndefined();
    // ⚠️ リダイレクトを追わない。追うと確かめた相手が変わる。
    expect(init?.redirect).toBe('manual');
  });

  it('応答が返れば、その状態コードを持ち帰る', async () => {
    const fake = (async () => new Response(null, { status: 405 })) as unknown as typeof fetch;

    const result = await probeWith(fake).probe('https://wallet.example.com/v1/holdings');

    expect(result.outcome).toEqual({ kind: 'response', statusCode: 405 });
    // POST しか受けない経路の 405 は、届いている証拠として扱う。
    expect(classifyProbe(result.outcome)).toEqual({
      succeeded: true,
      failureCode: null,
      httpStatus: 405,
    });
  });

  it('5xx は届いていても失敗にする', async () => {
    const fake = (async () => new Response(null, { status: 503 })) as unknown as typeof fetch;

    const result = await probeWith(fake).probe('https://wallet.example.com/v1/holdings');

    expect(classifyProbe(result.outcome)).toEqual({
      succeeded: false,
      failureCode: 'http_5xx',
      httpStatus: 503,
    });
  });

  it('時間内に応答が無ければ timeout', async () => {
    const fake = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      })) as unknown as typeof fetch;

    const probe = new ReachabilityProbe({ clock, timeoutMs: 5, fetchImpl: fake });
    const result = await probe.probe('https://wallet.example.com/v1/holdings');

    expect(result.outcome).toEqual({ kind: 'timeout' });
  });

  /*
    ⚠️ **知っている符号だけを通す。** Node の例外に載る `cause` には、
       実装によってホスト名や証明書の主体名が混ざる。
  */
  it('知っている接続の符号は、そのまま残す', async () => {
    const fake = (async () => {
      const error = new TypeError('fetch failed');
      (error as { cause?: unknown }).cause = { code: 'ENOTFOUND' };
      throw error;
    }) as unknown as typeof fetch;

    const result = await probeWith(fake).probe('https://wallet.example.com/v1/holdings');

    expect(result.outcome).toEqual({ kind: 'network', code: 'ENOTFOUND' });
  });

  it('知らない符号は落とす（内部情報を持ち帰らない）', async () => {
    const fake = (async () => {
      const error = new TypeError('fetch failed');
      (error as { cause?: unknown }).cause = {
        code: 'SOMETHING_WITH_wallet.internal.example.com',
      };
      throw error;
    }) as unknown as typeof fetch;

    const result = await probeWith(fake).probe('https://wallet.example.com/v1/holdings');

    expect(result.outcome).toEqual({ kind: 'network', code: null });
    expect(JSON.stringify(result)).not.toContain('internal.example.com');
  });

  it('例外の文面を持ち帰らない', async () => {
    const fake = (async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.5:443 (wallet.internal)');
    }) as unknown as typeof fetch;

    const result = await probeWith(fake).probe('https://wallet.example.com/v1/holdings');

    expect(JSON.stringify(result)).not.toContain('10.0.0.5');
    expect(JSON.stringify(result)).not.toContain('wallet.internal');
  });

  it('所要時間は負にならない', async () => {
    let calls = 0;
    const backwards = {
      now: (): Date =>
        new Date(calls++ === 0 ? '2026-08-18T00:00:10.000Z' : '2026-08-18T00:00:00.000Z'),
    };
    const fake = (async () => new Response(null, { status: 200 })) as unknown as typeof fetch;

    const probe = new ReachabilityProbe({ clock: backwards, timeoutMs: 5000, fetchImpl: fake });
    const result = await probe.probe('https://wallet.example.com/v1/holdings');

    expect(result.durationMs).toBe(0);
  });
});
