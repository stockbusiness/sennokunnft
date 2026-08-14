import { describe, expect, it, vi } from 'vitest';
import { canonicalString, contentHash, FixedClock, HttpWalletDeliverySender } from '../src/index';
import { createHmac } from 'node:crypto';

const NOW = new Date('2026-08-14T08:00:00.000Z');
const KEY_ID = 'market-to-wallet';
const SECRET = 'test-secret-value';
const ENDPOINT = 'https://wallet.example.jp/api/v1/entitlements/events?trace=1';

const PAYLOAD = JSON.stringify({
  event_id: 'evt_1',
  event_type: 'entitlement.granted',
  event_version: '1.0',
});

function buildSender(fetchImpl: typeof fetch): HttpWalletDeliverySender {
  return new HttpWalletDeliverySender({
    endpoint: ENDPOINT,
    keyId: KEY_ID,
    secret: SECRET,
    clock: new FixedClock(NOW),
    fetchImpl,
    nonceFactory: () => 'fixed-nonce',
  });
}

function captured(fetchImpl: ReturnType<typeof vi.fn>): {
  url: string;
  headers: Record<string, string>;
  body: string;
} {
  const call = fetchImpl.mock.calls[0] as [string, RequestInit];
  return {
    url: call[0],
    headers: call[1].headers as Record<string, string>,
    body: call[1].body as string,
  };
}

describe('Wallet への送信（千ノ国共通 HMAC v1.1 FINAL）', () => {
  it('受け取った本文をそのまま署名し、そのまま送る', async () => {
    // ⚠️ parse して stringify すると、キー順や空白が変わって
    //    署名対象と送信内容がずれる。相手からは 401 に見え、
    //    原因は本文に残らない。
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    await buildSender(fetchImpl as unknown as typeof fetch).send({
      eventId: 'evt_1',
      correlationId: 'corr_0123456789',
      payload: PAYLOAD,
    });

    const { headers, body } = captured(fetchImpl);
    expect(body).toBe(PAYLOAD);

    const expected = createHmac('sha256', SECRET)
      .update(
        canonicalString({
          keyId: KEY_ID,
          timestamp: String(Math.floor(NOW.getTime() / 1000)),
          nonce: 'fixed-nonce',
          method: 'POST',
          // ⚠️ クエリ文字列は正準文字列に含めない。
          path: '/api/v1/entitlements/events',
          rawBody: PAYLOAD,
        }),
        'utf8',
      )
      .digest('hex');
    expect(headers['x-sennokuni-signature']).toBe(`sha256=${expected}`);
  });

  it('Idempotency-Key に event_id を使う（§16）', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    await buildSender(fetchImpl as unknown as typeof fetch).send({
      eventId: 'evt_1',
      correlationId: 'corr_0123456789',
      payload: PAYLOAD,
    });

    expect(captured(fetchImpl).headers['idempotency-key']).toBe('evt_1');
  });

  it('X-Event-Version を本文の event_version から作る（§14）', async () => {
    // ⚠️ 定数から埋めると、片方だけ上げたときに食い違う。
    //    同じ 1 か所から作れば、食い違いは起こしようがない。
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const payload = JSON.stringify({ event_version: '2.7', event_id: 'evt_1' });
    await buildSender(fetchImpl as unknown as typeof fetch).send({
      eventId: 'evt_1',
      correlationId: 'corr_0123456789',
      payload,
    });

    const { headers, body } = captured(fetchImpl);
    expect(headers['x-event-version']).toBe('2.7');
    expect(JSON.parse(body)).toMatchObject({ event_version: '2.7' });
  });

  it('相関IDをそのまま引き継ぐ（§17）', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    await buildSender(fetchImpl as unknown as typeof fetch).send({
      eventId: 'evt_1',
      correlationId: 'corr_abcdefgh',
      payload: PAYLOAD,
    });

    expect(captured(fetchImpl).headers['x-correlation-id']).toBe('corr_abcdefgh');
  });

  it('応答の状態コードをそのまま返す', async () => {
    for (const statusCode of [200, 400, 409, 429, 500]) {
      const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: statusCode }));
      const outcome = await buildSender(fetchImpl as unknown as typeof fetch).send({
        eventId: 'evt_1',
        correlationId: 'corr_0123456789',
        payload: PAYLOAD,
      });
      expect(outcome).toEqual({ kind: 'response', statusCode });
    }
  });

  it('時間切れを timeout として返す', async () => {
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    const fetchImpl = vi.fn().mockRejectedValue(abortError);

    const outcome = await buildSender(fetchImpl as unknown as typeof fetch).send({
      eventId: 'evt_1',
      correlationId: 'corr_0123456789',
      payload: PAYLOAD,
    });
    expect(outcome).toEqual({ kind: 'timeout' });
  });

  it('通信の失敗を network として返し、例外の中身を漏らさない', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.1:443'));

    const outcome = await buildSender(fetchImpl as unknown as typeof fetch).send({
      eventId: 'evt_1',
      correlationId: 'corr_0123456789',
      payload: PAYLOAD,
    });
    // ⚠️ 例外の中身を返さない。URL や本文が混ざりうる。
    expect(outcome).toEqual({ kind: 'network' });
  });

  it('秘密鍵が空なら生成させない', () => {
    expect(
      () =>
        new HttpWalletDeliverySender({
          endpoint: ENDPOINT,
          keyId: KEY_ID,
          secret: '',
          clock: new FixedClock(NOW),
        }),
    ).toThrow();
  });
});

describe('内容ハッシュ', () => {
  it('sha256:<hex> の形で返す', () => {
    expect(contentHash('abc')).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('同じ内容なら同じ値、違えば違う値', () => {
    expect(contentHash('abc')).toBe(contentHash('abc'));
    expect(contentHash('abc')).not.toBe(contentHash('abd'));
  });

  it('文字列とバイト列で同じ値になる', () => {
    expect(contentHash('abc')).toBe(contentHash(new TextEncoder().encode('abc')));
  });
});
