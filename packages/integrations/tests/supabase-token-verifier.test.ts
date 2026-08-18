import { beforeAll, describe, expect, it } from 'vitest';
import {
  SignJWT,
  createLocalJWKSet,
  errors as joseErrors,
  exportJWK,
  generateKeyPair,
  type JWK,
  type JWTVerifyGetKey,
} from 'jose';
import { SupabaseTokenVerifier } from '../src/supabase-token-verifier';

/**
 * Supabase トークンの検証（`UD-801`）。
 *
 * ⚠️ **この試験の主題は「通ってはいけないものが通らないこと」。**
 * 正しいトークンが通るのは当たり前で、事故が起きるのは拒否側の穴。
 * とりわけ**アルゴリズムのすり替え**は、通ると認証が丸ごと破られる。
 */

const ISSUER = 'https://example.supabase.co/auth/v1';
const AUDIENCE = 'authenticated';
const SUBJECT = '5f0e0f6c-0000-4000-8000-000000000001';

/** グローバルの `CryptoKey` に頼らず、jose が返す型からそのまま取る。 */
type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

let signingKey: PrivateKey;
let publicJwk: JWK;
let otherSigningKey: PrivateKey;
let getKey: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair('ES256', { extractable: true });
  signingKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'key-1', alg: 'ES256', use: 'sig' };

  // 鍵束に入っていない別の鍵。交代直後の行き違いや、他所で作られたトークンを表す。
  const other = await generateKeyPair('ES256', { extractable: true });
  otherSigningKey = other.privateKey;

  getKey = createLocalJWKSet({ keys: [publicJwk] });
});

function verifier(overrides: Partial<ConstructorParameters<typeof SupabaseTokenVerifier>[0]> = {}) {
  return new SupabaseTokenVerifier({
    jwksUrl: 'https://example.supabase.co/auth/v1/.well-known/jwks.json',
    issuer: ISSUER,
    audience: AUDIENCE,
    getKey,
    ...overrides,
  });
}

async function sign(
  claims: Record<string, unknown>,
  options: { key?: PrivateKey; alg?: string; kid?: string; expSecFromNow?: number } = {},
): Promise<string> {
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: options.alg ?? 'ES256', kid: options.kid ?? 'key-1' })
    .setIssuedAt()
    .setExpirationTime(`${options.expSecFromNow ?? 3600}s`);
  return jwt.sign(options.key ?? signingKey);
}

describe('正しいトークン', () => {
  it('検証を通り、sub と有効期限を返す', async () => {
    const token = await sign({ sub: SUBJECT, iss: ISSUER, aud: AUDIENCE });
    const result = await verifier().verify(token);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.identity.subject).toBe(SUBJECT);
    expect(result.identity.provider).toBe('supabase');
    expect(result.identity.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('トークンに書かれたロールを読まない', async () => {
    // ⚠️ Supabase の `role` は認証状態であって本システムの権限ではない。
    //    ここで拾うと、トークンに書けば権限を名乗れることになる。
    const token = await sign({
      sub: SUBJECT,
      iss: ISSUER,
      aud: AUDIENCE,
      role: 'operator',
      app_metadata: { role: 'operator' },
    });
    const result = await verifier().verify(token);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    // ⚠️ 取り出す項目を**明示的に**固定する。増やすときは、その値が
    //    権限の根拠になりうるかを必ず考えること。
    expect(Object.keys(result.identity)).toEqual(['subject', 'provider', 'expiresAt', 'email']);
    expect(result.identity).not.toHaveProperty('role');
    expect(result.identity).not.toHaveProperty('app_metadata');
  });

  /**
   * 確認済みのメールアドレス（`UD-803`）。
   *
   * ⚠️ **招待の突き合わせにしか使わない値。** それでも、確認していない
   * アドレスを返してしまうと、宛先を名乗るだけでスタッフの権限を取れる。
   */
  it('確認済みのメールアドレスだけを返す', async () => {
    const token = await sign({
      sub: SUBJECT,
      iss: ISSUER,
      aud: AUDIENCE,
      email: 'staff@example.com',
      email_verified: true,
    });
    const result = await verifier().verify(token);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.identity.email).toBe('staff@example.com');
  });

  it('`user_metadata` 側に確認済みの印がある場合も受け取る', async () => {
    // Supabase は印をトップレベルにも `user_metadata` にも置く。
    // 片方だけ見ると、確認済みの人が招待を受け取れなくなる。
    const token = await sign({
      sub: SUBJECT,
      iss: ISSUER,
      aud: AUDIENCE,
      email: 'staff@example.com',
      user_metadata: { email_verified: true },
    });
    const result = await verifier().verify(token);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.identity.email).toBe('staff@example.com');
  });

  it('確認されていないメールアドレスは返さない', async () => {
    // ⚠️ ここが漏れると、宛先を名乗るだけで他人宛の招待を取れる。
    const token = await sign({
      sub: SUBJECT,
      iss: ISSUER,
      aud: AUDIENCE,
      email: 'attacker@example.com',
      email_verified: false,
    });
    const result = await verifier().verify(token);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.identity.email).toBeUndefined();
  });

  it('印そのものが無いときも返さない', async () => {
    const token = await sign({
      sub: SUBJECT,
      iss: ISSUER,
      aud: AUDIENCE,
      email: 'unknown@example.com',
    });
    const result = await verifier().verify(token);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.identity.email).toBeUndefined();
  });
});

describe('アルゴリズムのすり替えを拒む', () => {
  it('HS256 で署名されたトークンを受け付けない', async () => {
    // ⚠️ **公開鍵を鍵として HMAC したトークン**を通す実装が実在した。
    //    許可アルゴリズムを渡さないと、この経路で誰でもなりすませる。
    const secret = new TextEncoder().encode(JSON.stringify(publicJwk));
    const token = await new SignJWT({ sub: SUBJECT, iss: ISSUER, aud: AUDIENCE })
      .setProtectedHeader({ alg: 'HS256', kid: 'key-1' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(secret);

    const result = await verifier().verify(token);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.failure).toBe('unsupported_algorithm');
  });

  it('alg: none を受け付けない', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', kid: 'key-1' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ sub: SUBJECT, iss: ISSUER, aud: AUDIENCE, exp: 9999999999 }),
    ).toString('base64url');
    const token = `${header}.${payload}.`;

    const result = await verifier().verify(token);
    expect(result.ok).toBe(false);
  });
});

describe('拒むべきトークン', () => {
  it('発行元が違えば拒む', async () => {
    const token = await sign({ sub: SUBJECT, iss: 'https://evil.example/auth/v1', aud: AUDIENCE });
    const result = await verifier().verify(token);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.failure).toBe('issuer_mismatch');
  });

  it('宛先が違えば拒む', async () => {
    const token = await sign({ sub: SUBJECT, iss: ISSUER, aud: 'someone-else' });
    const result = await verifier().verify(token);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.failure).toBe('audience_mismatch');
  });

  it('期限が切れていれば拒む', async () => {
    const token = await sign(
      { sub: SUBJECT, iss: ISSUER, aud: AUDIENCE },
      { expSecFromNow: -7200 },
    );
    const result = await verifier({ clockToleranceSec: 0 }).verify(token);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.failure).toBe('expired');
  });

  it('sub が無ければ拒む', async () => {
    const token = await sign({ iss: ISSUER, aud: AUDIENCE });
    const result = await verifier().verify(token);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.failure).toBe('missing_subject');
  });

  it('鍵束に無い鍵で署名されていれば拒む', async () => {
    const token = await sign(
      { sub: SUBJECT, iss: ISSUER, aud: AUDIENCE },
      { key: otherSigningKey },
    );
    const result = await verifier().verify(token);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.failure).toBe('invalid_signature');
  });

  it('署名が改竄されていれば拒む', async () => {
    const token = await sign({ sub: SUBJECT, iss: ISSUER, aud: AUDIENCE });
    const parts = token.split('.');
    const tampered = `${parts[0]}.${parts[1]}.${'A'.repeat((parts[2] ?? '').length)}`;
    const result = await verifier().verify(tampered);
    expect(result.ok).toBe(false);
  });

  it.each(['', 'not-a-token', 'a.b', 'a.b.c.d'])('形が壊れていれば拒む（%s）', async (token) => {
    const result = await verifier().verify(token);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.failure).toBe('malformed');
  });
});

describe('こちら側の不調を利用者のせいにしない', () => {
  it('鍵束を取りに行けないときは 401 にせず投げ直す', async () => {
    // ⚠️ ここで `invalid_signature` を返すと 401 になり、利用者には
    //    「ログインが無効になった」と見える。何度やり直しても直らず、
    //    原因はこちらにあるのに記録も残らない。
    const failing: JWTVerifyGetKey = () => {
      throw new joseErrors.JWKSTimeout();
    };
    const token = await sign({ sub: SUBJECT, iss: ISSUER, aud: AUDIENCE });

    await expect(verifier({ getKey: failing }).verify(token)).rejects.toBeInstanceOf(
      joseErrors.JWKSTimeout,
    );
  });
});
