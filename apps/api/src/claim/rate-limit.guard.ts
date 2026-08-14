import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ApiError } from '@sengoku/contracts';
import type { ClockPort, RateLimiterPort } from '@sengoku/domain';
import { verifiedKeyId } from './hmac.guard';

/** 設定の注入トークン。引数の型からの自動解決に任せない（HMAC ガードと同じ理由）。 */
export const CLAIM_RATE_LIMIT_CONFIG = Symbol('CLAIM_RATE_LIMIT_CONFIG');

export interface ClaimRateLimitConfig {
  readonly limiter: RateLimiterPort;
  readonly clock: ClockPort;
  /** `GET`（状態取得）の 1 分あたり上限。 */
  readonly getPerMinute: number;
  /** `POST`（受取確定）の 1 分あたり上限。 */
  readonly postPerMinute: number;
}

const WINDOW_MS = 60_000;

/**
 * Claim API のレート制限（完成指示書 §17）。
 *
 * ⚠️ **HMAC の検証より「後」に置く。**
 * 前に置いて自己申告の鍵IDで数えると、攻撃者がその鍵IDを名乗って
 * 送りつけるだけで**正規の相手の枠を使い切らせられる。**
 * 弾いたつもりが、正規の利用者を締め出す道具になる。
 *
 * 検証を先に通しても危険は増えない。署名が合わない要求は
 * ハッシュ計算だけで弾かれ、**nonce の記録（DB 書き込み）まで進まない**
 * ためである（署名の確認後に記録する順序にしてある）。
 *
 * 認証前の物量そのものは、この層では受け止めない。
 * IP 単位の粗い制限は WAF / LB 側でかける前提（同 §17）。
 *
 * ⚠️ **`GET` と `POST` を同じ枠で数えない。**
 * Wallet の Claim 画面は `DELIVERY_PENDING` のあいだ 5 秒間隔で
 * `GET` をポーリングする。同じ枠にすると、その通常動作が
 * `POST`（受取確定）の枠を食いつぶし、**肝心の受取だけが弾かれる。**
 */
@Injectable()
export class ClaimRateLimitGuard implements CanActivate {
  constructor(@Inject(CLAIM_RATE_LIMIT_CONFIG) private readonly config: ClaimRateLimitConfig) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();

    const keyId = verifiedKeyId(request);
    if (keyId === undefined) {
      // 検証を通っていない要求はここまで来ない。来たなら並び順が壊れている。
      // 通してしまうより落ちたほうがよい。
      throw new Error('レート制限は HMAC 検証より後に適用すること');
    }

    const isConfirm = request.method.toUpperCase() === 'POST';
    const limit = isConfirm ? this.config.postPerMinute : this.config.getPerMinute;

    const decision = await this.config.limiter.consume({
      // 用途ごとに枠を分ける。GET の常用が POST の枠を食わないようにする。
      bucket: `claim:${isConfirm ? 'confirm' : 'status'}:${keyId}`,
      limit,
      windowMs: WINDOW_MS,
      now: this.config.clock.now(),
    });

    if (decision.allowed) {
      return true;
    }

    // いつ再送すればよいかを伝える。伝えないと、相手は当てずっぽうで
    // 送り直し、弾かれ続けて負荷だけが残る。
    http.getResponse<Response>().setHeader('Retry-After', String(decision.retryAfterSeconds));
    const body: ApiError = {
      error: {
        code: 'RATE_LIMITED',
        message: 'ただいま混み合っています。しばらくしてからお試しください。',
      },
    };
    throw new HttpException(body, HttpStatus.TOO_MANY_REQUESTS);
  }
}
