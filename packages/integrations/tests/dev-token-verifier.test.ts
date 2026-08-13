import { describe, expect, it } from 'vitest';
import { createDevToken, DevTokenVerifier } from '../src/index';

const SECRET = 'dev-secret-value';
const ISSUER = 'https://auth.example.test';
const AUDIENCE = 'sennokunnft';
const NOW = new Date('2026-06-01T00:00:00.000Z');
const NOW_SEC = Math.floor(NOW.getTime() / 1000);

function verifier(): DevTokenVerifier {
  return new DevTokenVerifier({
    secret: SECRET,
    issuer: ISSUER,
    audience: AUDIENCE,
    now: () => NOW,
  });
}

function token(
  overrides: Partial<Parameters<typeof createDevToken>[1]> = {},
  secret = SECRET,
): string {
  return createDevToken(secret, {
    sub: 'user-1',
    iss: ISSUER,
    aud: AUDIENCE,
    exp: NOW_SEC + 3600,
    ...overrides,
  });
}

describe('DevTokenVerifier（TEST_STRATEGY §3.6 Z-6/Z-7/Z-8）', () => {
  it('正しいトークンを受理する', async () => {
    const result = await verifier().verify(token());
    if (!result.ok) throw new Error(`expected success, got ${result.failure}`);
    expect(result.identity.subject).toBe('user-1');
  });

  it('署名が不正なら拒否する', async () => {
    const result = await verifier().verify(token({}, 'wrong-secret'));
    if (result.ok) throw new Error('expected failure');
    expect(result.failure).toBe('invalid_signature');
  });

  it('alg: none を拒否する（Z-7）', async () => {
    // トークン側が申告する alg を信用すると、署名検証をすり抜けられる。
    const forged = createDevToken(
      SECRET,
      { sub: 'u', iss: ISSUER, aud: AUDIENCE, exp: NOW_SEC + 60 },
      'none',
    );
    const result = await verifier().verify(forged);
    if (result.ok) throw new Error('expected failure');
    expect(result.failure).toBe('unsupported_algorithm');
  });

  it('別のアルゴリズムを申告するトークンを拒否する', async () => {
    const forged = createDevToken(
      SECRET,
      { sub: 'u', iss: ISSUER, aud: AUDIENCE, exp: NOW_SEC + 60 },
      'RS256',
    );
    const result = await verifier().verify(forged);
    if (result.ok) throw new Error('expected failure');
    expect(result.failure).toBe('unsupported_algorithm');
  });

  it('期限切れを拒否する（Z-8）', async () => {
    const result = await verifier().verify(token({ exp: NOW_SEC - 3600 }));
    if (result.ok) throw new Error('expected failure');
    expect(result.failure).toBe('expired');
  });

  it('わずかな時刻ずれは許容する', async () => {
    // クロックスキューで正当な利用者を弾かないため。
    const result = await verifier().verify(token({ exp: NOW_SEC - 30 }));
    expect(result.ok).toBe(true);
  });

  it('発行者が違えば拒否する', async () => {
    const result = await verifier().verify(token({ iss: 'https://evil.example.test' }));
    if (result.ok) throw new Error('expected failure');
    expect(result.failure).toBe('issuer_mismatch');
  });

  it('対象者が違えば拒否する', async () => {
    const result = await verifier().verify(token({ aud: 'other-app' }));
    if (result.ok) throw new Error('expected failure');
    expect(result.failure).toBe('audience_mismatch');
  });

  it('sub がなければ拒否する', async () => {
    const result = await verifier().verify(token({ sub: '' }));
    if (result.ok) throw new Error('expected failure');
    expect(result.failure).toBe('missing_subject');
  });

  it.each(['', 'abc', 'a.b', 'a.b.c.d'])('形式が壊れたトークン「%s」を拒否する', async (raw) => {
    const result = await verifier().verify(raw);
    if (result.ok) throw new Error('expected failure');
    expect(['malformed', 'unsupported_algorithm']).toContain(result.failure);
  });

  it('ペイロードを改竄すると署名検証で落ちる', async () => {
    const original = token();
    const [header, , signature] = original.split('.') as [string, string, string];
    const tampered = Buffer.from(
      JSON.stringify({ sub: 'admin', iss: ISSUER, aud: AUDIENCE, exp: NOW_SEC + 3600 }),
      'utf8',
    ).toString('base64url');

    const result = await verifier().verify(`${header}.${tampered}.${signature}`);
    if (result.ok) throw new Error('expected failure');
    expect(result.failure).toBe('invalid_signature');
  });

  it('ロールを名乗るクレームがあっても identity には現れない（Z-6）', async () => {
    // ロールの正は本システムの DB。トークンのクレームからは読まない。
    const withRole = createDevToken(SECRET, {
      sub: 'user-1',
      iss: ISSUER,
      aud: AUDIENCE,
      exp: NOW_SEC + 3600,
      // 余分なクレームを混ぜる
      ...({ role: 'operator' } as Record<string, unknown>),
    } as Parameters<typeof createDevToken>[1]);

    const result = await verifier().verify(withRole);
    if (!result.ok) throw new Error('expected success');
    expect(JSON.stringify(result.identity)).not.toContain('operator');
  });

  it('空のシークレットを拒否する', () => {
    expect(
      () => new DevTokenVerifier({ secret: '', issuer: ISSUER, audience: AUDIENCE }),
    ).toThrow();
  });
});
