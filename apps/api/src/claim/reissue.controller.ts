import { Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import type { Actor } from '@sengoku/auth';
import { CurrentActor, RequireAction } from '../auth/auth.guard';
import { ReissueService, type ReissuedClaim } from './reissue.service';

/**
 * 受取URLの再発行（`SECURITY_DESIGN.md` §8.1 / `UD-1009`）。
 *
 * ⚠️ **`@Public()` を付けない。** ここは購入者本人のログインが要る経路。
 * `RequireAction` で `claim.reissue` を要求し、所有権はサービス層で確かめる
 * （ガードだけで済ませると、他人のIDを指定して呼べる穴が残る）。
 *
 * ⚠️ **HMAC の Claim API とは別の入口。**
 * あちらは OVEW Wallet が代理で呼ぶ経路、こちらは購入者が
 * 自分のマイページから叩く経路。混ぜると、Wallet の資格情報で
 * 他人の受取先を差し替えられることになりかねない。
 */
@Controller('api/v1/entitlements')
export class ClaimReissueController {
  constructor(private readonly reissue: ReissueService) {}

  /**
   * 受取URLを再発行する。
   *
   * ⚠️ **応答に含まれる平文のトークンは、この 1 回しか出てこない。**
   * 保存しているのはハッシュだけなので、あとから再表示はできない。
   */
  @Post(':id/claim-token')
  @RequireAction('claim.reissue')
  @HttpCode(HttpStatus.CREATED)
  async reissueToken(
    @Param('id') entitlementId: string,
    @CurrentActor() actor: Actor,
  ): Promise<ReissuedClaim> {
    return this.reissue.reissue(entitlementId, actor);
  }
}
