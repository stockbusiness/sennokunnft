import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type {
  TokenVerificationFailure,
  TokenVerificationResult,
  TokenVerifierPort,
} from '@sengoku/auth';

/**
 * Supabase が発行した JWT の検証（`UD-801` 決定済 2026-08-18: JWKS / ES256）。
 *
 * ⚠️ **`alg` をトークン側に選ばせない。** `algorithms: ['ES256']` を必ず渡す。
 * 省くと `alg: none` や別方式へのすり替えを通してしまう（アルゴリズム混同）。
 *
 * ⚠️ **api は公開鍵しか持たない。** 設定が漏れてもトークンを偽造できない。
 * 共有シークレット方式では、鍵を持つ側が誰にでもなりすませる。
 *
 * ⚠️ **ロールをトークンから読まない。** Supabase の `role` クレームは
 * `authenticated` などの認証状態であって、本システムの権限ではない。
 * 権限の正は DB（`accounts.role`）。混同すると権限昇格になる。
 */
export interface SupabaseTokenVerifierOptions {
  /** 例: `https://<ref>.supabase.co/auth/v1/.well-known/jwks.json` */
  readonly jwksUrl: string;
  /** 例: `https://<ref>.supabase.co/auth/v1` */
  readonly issuer: string;
  /** Supabase の既定は `authenticated`。 */
  readonly audience: string;
  /** クロックスキューの許容（秒）。 */
  readonly clockToleranceSec?: number;
  /**
   * 未知の `kid` を見たときに鍵を取り直す最短間隔（秒）。
   *
   * ⚠️ **0 にしない。** でたらめな `kid` を大量に送るだけで
   * JWKS の取得を詰まらせられる。**こちらの障害として跳ね返る。**
   */
  readonly refreshCooldownSec?: number;
  /** 鍵取得の待ち時間（秒）。相手が黙ったときに要求を溜めない。 */
  readonly timeoutSec?: number;
  /** 試験用の差し替え口。 */
  readonly getKey?: JWTVerifyGetKey;
}

/** この検証器が受け入れる唯一の署名方式。 */
const ALGORITHM = 'ES256';

/** 認証プロバイダの識別子。`accounts.auth_provider` に入る値。 */
export const SUPABASE_AUTH_PROVIDER = 'supabase';

export class SupabaseTokenVerifier implements TokenVerifierPort {
  private readonly getKey: JWTVerifyGetKey;
  private readonly clockToleranceSec: number;

  constructor(private readonly options: SupabaseTokenVerifierOptions) {
    this.clockToleranceSec = options.clockToleranceSec ?? 60;
    this.getKey =
      options.getKey ??
      createRemoteJWKSet(new URL(options.jwksUrl), {
        // 未知の kid で取り直すときの最短間隔。総当たりで取得を詰まらせないため。
        cooldownDuration: (options.refreshCooldownSec ?? 60) * 1000,
        // 鍵の入れ替えに追従する。長すぎると交代後しばらく誰も入れなくなる。
        cacheMaxAge: 10 * 60 * 1000,
        timeoutDuration: (options.timeoutSec ?? 5) * 1000,
      });
  }

  async verify(token: string): Promise<TokenVerificationResult> {
    try {
      const { payload } = await jwtVerify(token, this.getKey, {
        // ⚠️ ここを省かない。トークン側の alg を信用しないための要。
        algorithms: [ALGORITHM],
        issuer: this.options.issuer,
        audience: this.options.audience,
        clockTolerance: this.clockToleranceSec,
      });

      const subject = payload.sub;
      if (typeof subject !== 'string' || subject.length === 0) {
        return { ok: false, failure: 'missing_subject' };
      }
      if (typeof payload.exp !== 'number') {
        // jose が exp 無しを通すことはないが、型の上で保証されないので確かめる。
        return { ok: false, failure: 'malformed' };
      }

      return {
        ok: true,
        identity: {
          subject,
          provider: SUPABASE_AUTH_PROVIDER,
          expiresAt: new Date(payload.exp * 1000),
          ...(typeof payload.iat === 'number' ? { issuedAt: new Date(payload.iat * 1000) } : {}),
          email: verifiedEmail(payload),
        },
      };
    } catch (error) {
      const failure = classify(error);
      if (failure === null) {
        // ⚠️ **鍵を取りに行けない失敗を 401 にしない。**
        //    それはこちら側の不調であって、利用者のトークンの問題ではない。
        //    401 を返すと「ログインが無効になった」と受け取られ、
        //    利用者が再ログインを繰り返す。原因も残らない。
        throw error;
      }
      return { ok: false, failure };
    }
  }
}

/**
 * jose の例外を、ポートが定める失敗理由へ写す。
 *
 * `null` は「トークンの問題ではない」を表す。呼び出し元が投げ直す。
 */
function classify(error: unknown): TokenVerificationFailure | null {
  if (error instanceof joseErrors.JWTExpired) {
    return 'expired';
  }
  if (error instanceof joseErrors.JWTClaimValidationFailed) {
    if (error.claim === 'iss') return 'issuer_mismatch';
    if (error.claim === 'aud') return 'audience_mismatch';
    if (error.claim === 'sub') return 'missing_subject';
    return 'malformed';
  }
  if (error instanceof joseErrors.JOSEAlgNotAllowed) {
    return 'unsupported_algorithm';
  }
  if (error instanceof joseErrors.JWSSignatureVerificationFailed) {
    return 'invalid_signature';
  }
  // 署名した鍵が鍵束に無い。交代直後の行き違いか、他所で作られたトークン。
  if (error instanceof joseErrors.JWKSNoMatchingKey) {
    return 'invalid_signature';
  }
  if (
    error instanceof joseErrors.JWSInvalid ||
    error instanceof joseErrors.JWTInvalid ||
    error instanceof joseErrors.JWEInvalid
  ) {
    return 'malformed';
  }
  // JWKSTimeout・ネットワーク不達などはこちら側の不調。投げ直す。
  return null;
}

/**
 * 確認済みのメールアドレスだけを取り出す（`UD-803`）。
 *
 * ⚠️ **`email_verified` が真でなければ返さない。** Supabase は
 * 未確認のアドレスでもトークンへ `email` を載せうる。確認していない値で
 * 招待を突き合わせると、他人の宛先を名乗って権限を取れる。
 *
 * ⚠️ **見る場所を 1 つに決めない。** Supabase は確認済みの印を
 * トップレベルにも `user_metadata` にも置く。片方だけ見ると、
 * 確認済みの人が「未確認」として弾かれ、招待を受け取れなくなる。
 *
 * ⚠️ **ここで得た値をロールの判断に使わない。** 使ってよいのは
 * 「招待の宛先と同じ人か」の突き合わせだけ。
 */
function verifiedEmail(payload: Record<string, unknown>): string | undefined {
  const email = payload.email;
  if (typeof email !== 'string' || email.length === 0) {
    return undefined;
  }

  const metadata = payload.user_metadata;
  const fromMetadata =
    typeof metadata === 'object' && metadata !== null
      ? (metadata as Record<string, unknown>).email_verified
      : undefined;

  return payload.email_verified === true || fromMetadata === true ? email : undefined;
}
