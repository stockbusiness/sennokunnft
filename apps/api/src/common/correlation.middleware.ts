import { randomUUID } from 'node:crypto';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { runWithRequestContext } from '@sengoku/observability';

/** ヘッダ名。両システムで同じ綴りを使う。 */
export const CORRELATION_HEADER = 'x-correlation-id';

/**
 * 相関IDの許容形式。
 *
 * ⚠️ **受け取った値をそのまま信用しない。**
 * 相手が付けた値は、そのままログへ書き込まれ、応答ヘッダへ反映される。
 * 改行や制御文字が入ると**ログの行を偽装できる**（1 件の記録を
 * 複数件に見せかけたり、実際には無かった記録を混ぜたりできる）。
 * 長さも制限しないと、ログを膨らませる手口に使える。
 *
 * UUID・ULID・英数字とハイフン程度に限る。外れた値は**採用せず、
 * こちらで発番する**（拒否して要求を落とすほどのことではない）。
 */
const ALLOWED = /^[A-Za-z0-9._-]{8,128}$/;

/**
 * 相関IDを要求ごとに確定させ、以降のログすべてに付ける。
 *
 * ⚠️ **すべての経路へ適用する。**
 * Claim だけに付けると、障害調査のときに「Claim の手前で落ちた要求」が
 * 追えない。相手のログと突き合わせられる範囲が広いほど、
 * 「どちらのシステムで起きたのか」を早く切り分けられる。
 */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    const requestId = normalize(request.headers[CORRELATION_HEADER]);

    // 相手が突き合わせられるよう、採用した値を返す。
    // ⚠️ 検証を通った値だけを返す。素通しするとヘッダ分割に使われる。
    response.setHeader('X-Correlation-Id', requestId);

    // ここから先のログはすべてこの ID を持つ。
    runWithRequestContext({ requestId }, () => {
      next();
    });
  }
}

function normalize(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value !== undefined && ALLOWED.test(value)) {
    return value;
  }
  // ⚠️ `Math.random()` を使わない。推測できる値だと、
  //    他人の要求の記録を狙って引き当てられる余地が生まれる。
  return randomUUID();
}
