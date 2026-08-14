import { describe, expect, it } from 'vitest';
import { AgencyCommonUserDirectory, FakeCommonUserDirectory } from '../src/index';

/**
 * 代理店システムのアダプタ（実装指示書 §22.1）。
 *
 * ⚠️ 確かめたいのは「失敗をどう分類するか」。
 * 分類を誤ると、直らないものを叩き続けるか、直るものを諦めるかのどちらかになる。
 */

const CU = 'cu_' + 'a'.repeat(32);

function directory(fetchImpl: typeof fetch): AgencyCommonUserDirectory {
  return new AgencyCommonUserDirectory({
    baseUrl: 'https://agency.test',
    apiKey: 'test-api-key',
    systemKey: 'sennokuni-nft-market',
    timeoutMs: 50,
    fetchImpl,
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const input = {
  systemKey: 'sennokuni-nft-market',
  externalUserId: 'account-1',
  createIfMissing: true,
};

describe('要求の組み立て', () => {
  it('APIキーを付け、account id を鍵として送る', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const port = directory(((url: string, init: RequestInit) => {
      seen = { url, init };
      return Promise.resolve(
        jsonResponse(200, { ok: true, common_user_id: CU, matched_by: 'created' }),
      );
    }) as unknown as typeof fetch);

    await port.resolve(input);

    expect(seen).not.toBeNull();
    const call = seen as unknown as { url: string; init: RequestInit };
    expect(call.url).toBe('https://agency.test/api/common-users/resolve');
    expect((call.init.headers as Record<string, string>)['x-api-key']).toBe('test-api-key');

    const body = JSON.parse(String(call.init.body)) as Record<string, unknown>;
    expect(body).toEqual({
      system_key: 'sennokuni-nft-market',
      external_user_id: 'account-1',
      create_if_missing: true,
    });
  });

  it('create_if_missing を必ず送る（相手の既定 true に任せない）', async () => {
    let body: Record<string, unknown> = {};
    const port = directory(((_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return Promise.resolve(
        jsonResponse(200, { ok: true, common_user_id: CU, matched_by: 'system_account_link' }),
      );
    }) as unknown as typeof fetch);

    await port.resolve({ ...input, createIfMissing: false });
    expect(body.create_if_missing).toBe(false);
  });

  it('メール・電話・ウォレットを送らない', async () => {
    // 未検証の属性を送ると、他人の検証済み ID に当たって紐付く経路ができる。
    let body: Record<string, unknown> = {};
    const port = directory(((_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return Promise.resolve(
        jsonResponse(200, { ok: true, common_user_id: CU, matched_by: 'created' }),
      );
    }) as unknown as typeof fetch);

    await port.resolve(input);
    expect(Object.keys(body)).not.toContain('email');
    expect(Object.keys(body)).not.toContain('phone');
    expect(Object.keys(body)).not.toContain('wallet_address');
  });
});

describe('失敗の分類（§22.1）', () => {
  it('5xx は一時的な失敗として扱う', async () => {
    const port = directory((() => Promise.resolve(jsonResponse(503, {}))) as typeof fetch);
    const result = await port.resolve(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('transient');
  });

  it('4xx は再試行しない失敗として扱う', async () => {
    // 同じ内容で送り直しても結果は変わらない。
    const port = directory((() => Promise.resolve(jsonResponse(422, {}))) as typeof fetch);
    const result = await port.resolve(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('permanent');
  });

  it('通信できないときは一時的な失敗として扱う', async () => {
    const port = directory((() => Promise.reject(new Error('ECONNREFUSED'))) as typeof fetch);
    const result = await port.resolve(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('transient');
    expect(result.reason).toBe('network_error');
  });

  it('時間切れは一時的な失敗として扱う', async () => {
    const port = directory((() => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      return Promise.reject(error);
    }) as typeof fetch);
    const result = await port.resolve(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('transient');
    expect(result.reason).toBe('timeout');
  });

  it('失敗の理由に例外の中身をそのまま入れない', async () => {
    // URL や本文が混ざるとログへ漏れる。
    const port = directory((() =>
      Promise.reject(
        new Error('connect to https://agency.test failed for user@example.com'),
      )) as typeof fetch);
    const result = await port.resolve(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).not.toContain('example.com');
    expect(result.reason).not.toContain('agency.test');
  });

  it('契約と違う応答は受け入れず、補って進めない', async () => {
    const port = directory((() =>
      Promise.resolve(jsonResponse(200, { ok: true, matched_by: 'created' }))) as typeof fetch);
    const result = await port.resolve(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unexpected_response_shape');
  });

  it('知らない matched_by は受け入れない', async () => {
    const port = directory((() =>
      Promise.resolve(
        jsonResponse(200, { ok: true, common_user_id: CU, matched_by: 'something_new' }),
      )) as typeof fetch);
    const result = await port.resolve(input);
    expect(result.ok).toBe(false);
  });

  it('JSON として読めない応答は一時的な失敗として扱う', async () => {
    const port = directory((() =>
      Promise.resolve(new Response('<html>502</html>', { status: 200 }))) as typeof fetch);
    const result = await port.resolve(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('transient');
  });
});

describe('応答の読み取り', () => {
  it('identity_match_status をそのまま伝える', async () => {
    const port = directory((() =>
      Promise.resolve(
        jsonResponse(200, {
          ok: true,
          common_user_id: CU,
          matched_by: 'created',
          identity_match_status: 'unverified_candidate_not_auto_merged',
        }),
      )) as typeof fetch);

    const result = await port.resolve(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolution.identityMatchStatus).toBe('unverified_candidate_not_auto_merged');
  });

  it('知らない項目が増えても壊れない', async () => {
    const port = directory((() =>
      Promise.resolve(
        jsonResponse(200, {
          ok: true,
          common_user_id: CU,
          matched_by: 'created',
          brand_new_field: { nested: true },
        }),
      )) as typeof fetch);

    const result = await port.resolve(input);
    expect(result.ok).toBe(true);
  });
});

describe('擬似実装', () => {
  it('同じ account id には同じ値を返す', async () => {
    const fake = new FakeCommonUserDirectory();
    const first = await fake.resolve(input);
    const second = await fake.resolve(input);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.resolution.commonUserId).toBe(first.resolution.commonUserId);
    expect(second.resolution.matchedBy).toBe('system_account_link');
  });

  it('契約どおりの形式を返す', async () => {
    const fake = new FakeCommonUserDirectory();
    const result = await fake.resolve(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolution.commonUserId).toMatch(/^cu_[0-9a-f]{32}$/);
  });

  it('createIfMissing が false で未登録なら見つからない', async () => {
    const fake = new FakeCommonUserDirectory();
    const result = await fake.resolve({ ...input, createIfMissing: false });
    expect(result.ok).toBe(false);
  });
});
