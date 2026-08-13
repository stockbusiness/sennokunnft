import { createHmac, timingSafeEqual } from 'node:crypto';
import type { TokenVerifierPort, TokenVerificationResult } from '@sengoku/auth';

/**
 * 開発・テスト用のトークン検証。
 *
 * ✅ **本番 Supabase へ接続しない。** 検証方式は未決定（`UD-801`）で、
 * 共有シークレット（HS256）と JWKS（非対称鍵）のどちらになるか決まっていない。
 * 決まるまで実装を固定せず、ポートの差し替えで対応できるようにしてある。
 *
 * ⚠️ **これを本番で使ってはならない。**
 * 誰でもトークンを作れてしまう。`APP_ENV=production` のときは
 * 起動時に拒否する仕組みを `@sengoku/config` 側に置いてある。
 *
 * 擬似実装ではあるが、**検証手順は本物と同じ順序**にしてある。
 * ここを簡略化すると、実装を差し替えたときに手順の欠落に気付けない。
 */
export interface DevTokenClaims {
  readonly sub: string;
  readonly iss: string;
  readonly aud: string;
  readonly exp: number;
}

export interface DevTokenVerifierOptions {
  readonly secret: string;
  readonly issuer: string;
  readonly audience: string;
  /** クロックスキューの許容（秒）。 */
  readonly clockToleranceSec?: number;
  readonly now?: () => Date;
}

const SUPPORTED_ALGORITHM = 'HS256';

function base64UrlDecode(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf8');
}

function base64UrlEncode(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

/** 開発用トークンを作る。テストと手元確認でのみ使う。 */
export function createDevToken(
  secret: string,
  claims: DevTokenClaims,
  algorithm = SUPPORTED_ALGORITHM,
): string {
  const header = base64UrlEncode(JSON.stringify({ alg: algorithm, typ: 'JWT' }));
  const payload = base64UrlEncode(JSON.stringify(claims));
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

export class DevTokenVerifier implements TokenVerifierPort {
  private readonly clockToleranceSec: number;
  private readonly now: () => Date;

  constructor(private readonly options: DevTokenVerifierOptions) {
    if (options.secret.length === 0) {
      throw new Error('dev token secret must not be empty');
    }
    this.clockToleranceSec = options.clockToleranceSec ?? 60;
    this.now = options.now ?? (() => new Date());
  }

  verify(token: string): Promise<TokenVerificationResult> {
    return Promise.resolve(this.verifySync(token));
  }

  private verifySync(token: string): TokenVerificationResult {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return { ok: false, failure: 'malformed' };
    }
    const [encodedHeader, encodedPayload, signature] = parts as [string, string, string];

    let header: { alg?: unknown };
    let claims: Partial<DevTokenClaims>;
    try {
      header = JSON.parse(base64UrlDecode(encodedHeader)) as { alg?: unknown };
      claims = JSON.parse(base64UrlDecode(encodedPayload)) as Partial<DevTokenClaims>;
    } catch {
      return { ok: false, failure: 'malformed' };
    }

    // ⚠️ トークン側が申告する alg を信用せず、期待する値と一致するかを確かめる。
    //    これを省くと `alg: none` や別方式へのすり替えを通してしまう。
    if (header.alg !== SUPPORTED_ALGORITHM) {
      return { ok: false, failure: 'unsupported_algorithm' };
    }

    const expected = createHmac('sha256', this.options.secret)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest('base64url');
    if (!safeCompare(expected, signature)) {
      return { ok: false, failure: 'invalid_signature' };
    }

    // 署名を確かめてから、はじめてクレームを解釈する。
    if (claims.iss !== this.options.issuer) {
      return { ok: false, failure: 'issuer_mismatch' };
    }
    if (claims.aud !== this.options.audience) {
      return { ok: false, failure: 'audience_mismatch' };
    }
    if (typeof claims.sub !== 'string' || claims.sub.length === 0) {
      return { ok: false, failure: 'missing_subject' };
    }
    if (typeof claims.exp !== 'number') {
      return { ok: false, failure: 'malformed' };
    }

    const nowSec = Math.floor(this.now().getTime() / 1000);
    if (claims.exp + this.clockToleranceSec < nowSec) {
      return { ok: false, failure: 'expired' };
    }

    return {
      ok: true,
      identity: {
        subject: claims.sub,
        provider: 'dev',
        expiresAt: new Date(claims.exp * 1000),
      },
    };
  }
}

function safeCompare(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}
