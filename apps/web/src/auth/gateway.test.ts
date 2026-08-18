import { describe, expect, it } from 'vitest';
import { SupabaseAuthGateway } from './gateway';

/**
 * Supabase へ送る要求の形を固定する。
 *
 * ⚠️ **本物の Supabase へは繋がない。** 試験のたびにメールが飛ぶ。
 * 代わりに、**送る内容が変わったら気付ける**ように固定する。
 * 実地の往復は別に確かめる必要がある（この試験では代替できない）。
 */

const URL_BASE = 'https://example.supabase.co';
const ANON = 'anon-public-key';
const NOW = new Date('2026-06-01T00:00:00.000Z');

interface Captured {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

function gateway(respond: (captured: Captured) => Response) {
  const calls: Captured[] = [];
  const fetchImpl = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const captured: Captured = {
      url: String(input),
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
    };
    calls.push(captured);
    return Promise.resolve(respond(captured));
  };
  return {
    calls,
    instance: new SupabaseAuthGateway({
      url: URL_BASE,
      anonKey: ANON,
      fetchImpl: fetchImpl as typeof fetch,
      now: () => NOW,
    }),
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('ログイン用リンクの送信', () => {
  it('宛先・戻り先・鍵を正しく送る', async () => {
    const g = gateway(() => json({}));
    const result = await g.instance.sendMagicLink(
      'tanaka@example.jp',
      'https://market.example/api/auth/confirm',
    );

    expect(result.ok).toBe(true);
    const [call] = g.calls;
    expect(call?.url).toBe(
      'https://example.supabase.co/auth/v1/otp?redirect_to=https%3A%2F%2Fmarket.example%2Fapi%2Fauth%2Fconfirm',
    );
    expect(call?.headers.apikey).toBe(ANON);
    // 未登録なら登録も兼ねる。登録とログインを分けると、利用者が
    // 自分がどちらか覚えていないと進めなくなる。
    expect(call?.body).toEqual({ email: 'tanaka@example.jp', create_user: true });
  });

  it('登録済みかどうかで応答を変えない', async () => {
    // ⚠️ 変えると、アドレスの当てずっぽうで「誰が登録しているか」を調べられる。
    const ok = gateway(() => json({}));
    expect((await ok.instance.sendMagicLink('a@example.jp', 'https://x/y')).ok).toBe(true);
    const also = gateway(() => json({}));
    expect((await also.instance.sendMagicLink('b@example.jp', 'https://x/y')).ok).toBe(true);
  });

  it('相手が断ったら rejected', async () => {
    const g = gateway(() => json({ error: 'nope' }, 400));
    const result = await g.instance.sendMagicLink('a@example.jp', 'https://x/y');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toBe('rejected');
  });

  it('通信そのものが失敗したら unavailable', async () => {
    const failing = new SupabaseAuthGateway({
      url: URL_BASE,
      anonKey: ANON,
      fetchImpl: (() => Promise.reject(new Error('network'))) as unknown as typeof fetch,
    });
    const result = await failing.sendMagicLink('a@example.jp', 'https://x/y');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    // ⚠️ 相手が断ったのか、届かなかったのかを混ぜない。画面に出す言葉が違う。
    expect(result.reason).toBe('unavailable');
  });
});

describe('リンクの引き換え', () => {
  it('token_hash を verify へ送る', async () => {
    const g = gateway(() =>
      json({ access_token: 'at', refresh_token: 'rt', expires_at: 1_800_000_000 }),
    );
    const result = await g.instance.confirm('hash-value', 'magiclink');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(g.calls[0]?.url).toBe('https://example.supabase.co/auth/v1/verify');
    expect(g.calls[0]?.body).toEqual({ type: 'magiclink', token_hash: 'hash-value' });
    expect(result.data).toEqual({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: 1_800_000_000,
    });
  });

  it('絶対時刻が無ければ expires_in から求める', async () => {
    const g = gateway(() => json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }));
    const result = await g.instance.confirm('h', 'magiclink');
    if (!result.ok) throw new Error('expected success');
    expect(result.data.expiresAt).toBe(Math.floor(NOW.getTime() / 1000) + 3600);
  });

  it('絶対時刻があればそちらを優先する', async () => {
    // ⚠️ expires_in はこちらの時計とのずれをそのまま持ち込む。
    const g = gateway(() =>
      json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, expires_at: 12345 }),
    );
    const result = await g.instance.confirm('h', 'magiclink');
    if (!result.ok) throw new Error('expected success');
    expect(result.data.expiresAt).toBe(12345);
  });

  it('トークンが欠けた応答を成功にしない', async () => {
    const g = gateway(() => json({ access_token: 'at' }));
    const result = await g.instance.confirm('h', 'magiclink');
    expect(result.ok).toBe(false);
  });

  it('使い終わった・偽のリンクは rejected', async () => {
    const g = gateway(() => json({ error: 'expired' }, 401));
    const result = await g.instance.confirm('h', 'magiclink');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toBe('rejected');
  });
});

describe('取り直し', () => {
  it('grant_type=refresh_token を付けて送る', async () => {
    const g = gateway(() => json({ access_token: 'at2', refresh_token: 'rt2', expires_in: 3600 }));
    const result = await g.instance.refresh('rt1');

    expect(result.ok).toBe(true);
    expect(g.calls[0]?.url).toBe(
      'https://example.supabase.co/auth/v1/token?grant_type=refresh_token',
    );
    expect(g.calls[0]?.body).toEqual({ refresh_token: 'rt1' });
  });
});

describe('ログアウト', () => {
  it('利用者のトークンで相手側のセッションも終わらせる', async () => {
    const g = gateway(() => new Response(null, { status: 204 }));
    await g.instance.signOut('user-access-token');

    expect(g.calls[0]?.url).toBe('https://example.supabase.co/auth/v1/logout');
    // ⚠️ 公開鍵ではなく利用者のトークンで呼ぶ。でないと誰のセッションか定まらない。
    expect(g.calls[0]?.headers.authorization).toBe('Bearer user-access-token');
  });

  it('相手側が失敗しても投げない', async () => {
    // ⚠️ こちらの Cookie は必ず消す。相手側が消えなくても、
    //    手元に残るほうが害が大きい。
    const failing = new SupabaseAuthGateway({
      url: URL_BASE,
      anonKey: ANON,
      fetchImpl: (() => Promise.reject(new Error('network'))) as unknown as typeof fetch,
    });
    await expect(failing.signOut('at')).resolves.toBeUndefined();
  });
});
