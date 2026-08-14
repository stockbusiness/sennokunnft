import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import type { ApiError } from '@sengoku/contracts';
import type { SenNoKuniHmacVerifier, HmacFailure } from '@sengoku/integrations';
import type { ClockPort } from '@sengoku/domain';
import type { Logger } from '@sengoku/observability';

/**
 * ガードへ渡す設定の注入トークン。
 *
 * ⚠️ **引数の型からの自動解決に任せない。**
 * 検証器も時計もインタフェース越しに受け取るため、型情報だけでは
 * Nest が何を渡せばよいか決められない。任せると**別の空インスタンスが
 * 作られ、`enabled` が `undefined` のまま素通り判定に使われる**。
 * 実際にそれが起き、有効にしたはずの Claim API が全部 404 を返していた。
 */
export const CLAIM_HMAC_CONFIG = Symbol('CLAIM_HMAC_CONFIG');

/** ガードが動くために必要なもの。 */
export interface ClaimHmacConfig {
  readonly verifier: SenNoKuniHmacVerifier | null;
  readonly clock: ClockPort;
  /** 連携が無効なときは無くてよい。その場合は 404 で先に返る。 */
  readonly logger: Logger | null;
  /** 連携が有効か。無効なら存在ごと隠す。 */
  readonly enabled: boolean;
}

/** `rawBody: true` で起動したときに Express の要求へ生えるフィールド。 */
type RawBodyRequest = Request & { readonly rawBody?: Buffer };

/**
 * 千ノ国共通 HMAC v1.1 FINAL による呼び出し元の検証。
 *
 * ⚠️ **`@Public()` だけを付けたエンドポイントを作らない。**
 * `@Public()` は JWT を要求しないという意味でしかない。
 * Claim API は Wallet が代理で呼ぶため JWT が無いが、
 * だからといって誰でも呼べてよいわけではない。
 * **本ガードをクラス単位で掛け、外し忘れが起きない形にする。**
 *
 * ⚠️ **設定が無いときは通さない（fail closed）。**
 * 鍵が未設定なら「検証できない」であって「検証不要」ではない。
 * ここを素通りにすると、設定漏れがそのまま無認証の口になる。
 */
@Injectable()
export class SenNoKuniHmacGuard implements CanActivate {
  constructor(@Inject(CLAIM_HMAC_CONFIG) private readonly config: ClaimHmacConfig) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RawBodyRequest>();

    // 連携が無効なら 404。「機能はあるが止めてある」ことも伏せる。
    const { verifier, enabled } = this.config;
    if (!enabled || verifier === null) {
      throw notFound();
    }

    // ⚠️ **パース済みの本文から署名対象を作り直さない。**
    // JSON を parse して stringify すると、キーの順序や空白が変わり、
    // 送信側が署名した文字列と別物になる。署名は受信したバイト列そのものに対して行う。
    // 本文が無い要求（GET）では rawBody 自体が生えないため、空文字として扱う。
    const rawBody = request.rawBody?.toString('utf8') ?? '';

    const verification = await verifier.verify({
      headers: normalizeHeaders(request.headers),
      method: request.method,
      // ⚠️ クエリ文字列を含めない。`originalUrl` は含んでしまうので使わない。
      path: request.path,
      rawBody,
      now: this.config.clock.now(),
    });

    if (verification.ok) {
      return true;
    }

    // ⚠️ **失敗理由は記録するだけで、応答に載せない。**
    // 「鍵が違う」「時刻がずれている」「nonce が使用済み」を返すと、
    // どこまで合っていたかを攻撃者に教えることになる。
    this.config.logger?.warn(
      { failure: verification.failure, path: request.path },
      'HMAC 署名の検証に失敗しました',
    );
    throw unauthorized(verification.failure);
  }
}

/**
 * 応答の作り分け。
 *
 * ヘッダが足りない要求は 401（資格情報が無い）、
 * 署名まで揃っていて合わなかったものは 403（資格情報が正しくない）にする。
 * ⚠️ **この区別より細かい情報を本文に載せない。**
 */
function unauthorized(failure: HmacFailure): HttpException {
  const missing = failure === 'missing_headers';
  const body: ApiError = {
    error: {
      code: missing ? 'UNAUTHENTICATED' : 'FORBIDDEN',
      message: 'この操作を行う権限がありません。',
    },
  };
  return new HttpException(body, missing ? HttpStatus.UNAUTHORIZED : HttpStatus.FORBIDDEN);
}

function notFound(): HttpException {
  const body: ApiError = {
    error: { code: 'NOT_FOUND', message: 'お探しのページは見つかりませんでした。' },
  };
  return new HttpException(body, HttpStatus.NOT_FOUND);
}

/** Express のヘッダは配列になりうるので、先頭だけを見る形に均す。 */
function normalizeHeaders(
  headers: Request['headers'],
): Readonly<Record<string, string | undefined>> {
  const normalized: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return normalized;
}
