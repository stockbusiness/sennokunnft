import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from '@sengoku/validation';
import { Public } from '../auth/auth.guard';
import { parseOrThrow } from '../common/validation';
import { SenNoKuniHmacGuard } from './hmac.guard';
import { ClaimRateLimitGuard } from './rate-limit.guard';
import { ClaimService, type ClaimConfirmation, type ClaimView } from './claim.service';

/**
 * 本文のスキーマ。
 *
 * ⚠️ **形を検証しても、本人だと確かめたことにはならない。**
 * `common_user_id` は自己申告の識別子。呼び出し元が OVEW Wallet であることは
 * HMAC ガードが、購入者本人であることはサービス層が確かめる。
 * ここで見るのは「代理店システムの契約どおりの形か」だけ。
 */
const confirmBodySchema = z.object({
  common_user_id: z.string().regex(/^cu_[0-9a-f]{32}$/, 'common_user_id の形式が正しくありません'),
});

/**
 * Claim API（API_DESIGN.md §3-2 / `UD-1005`〜`UD-1007` 確定）。
 *
 * ⚠️ **パスは相手システムと合わせた契約。片方だけ変えると通信が成立しない。**
 * 旧案の `/api/v1/claims/{token}` は採用しない。
 *
 * ⚠️ **`@Public()` は「JWT を要求しない」という意味でしかない。**
 * 無認証という意味ではない。身元の確認は `SenNoKuniHmacGuard` が行う。
 * クラス単位で掛けてあるので、ここへメソッドを足しても保護から外れない。
 */
/**
 * ⚠️ **ガードの並び順が仕様。**
 * レート制限は HMAC 検証の**後**に置く。前に置くと自己申告の鍵IDで
 * 数えることになり、その鍵IDを名乗って送りつけるだけで
 * **正規の相手の枠を使い切らせられる。**
 */
@Controller('api/collectible-claims')
@UseGuards(SenNoKuniHmacGuard, ClaimRateLimitGuard)
export class ClaimController {
  constructor(private readonly claims: ClaimService) {}

  /** 受取りの状態を返す。✅ 応答は status / card_name / expires_at に固定。 */
  @Get(':token')
  @Public()
  async view(@Param('token') token: string): Promise<ClaimView> {
    return this.claims.view(token);
  }

  /**
   * 受取りを確定する。
   *
   * ✅ **成功は `202`。** 受け付けたところまでで、Wallet への配送は非同期。
   * ここで `200` を返すと「届いた」と読めてしまう。
   */
  @Post(':token/confirm')
  @Public()
  @HttpCode(HttpStatus.ACCEPTED)
  async confirm(
    @Param('token') token: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<ClaimConfirmation> {
    const parsed = parseOrThrow(confirmBodySchema, body);
    // ⚠️ **必須にする。** 省略を許すと、DB は更新できたが応答だけ失われた
    //    ときの再送を業務側で止められない（nonce は新しくなるので効かない）。
    const key = this.claims.requireIdempotencyKey(idempotencyKey);
    return this.claims.confirm(token, parsed.common_user_id, key);
  }
}
