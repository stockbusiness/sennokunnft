import { ConflictException, Injectable } from '@nestjs/common';
import {
  evaluateReissue,
  type AuditLogPort,
  type ClaimRepositoryPort,
  type ClaimTokenPort,
  type ClockPort,
} from '@sengoku/domain';
import type { Actor } from '@sengoku/auth';
import type { ApiError } from '@sengoku/contracts';
import { DomainErrorException } from '../common/domain-error.filter';

/** 再発行の結果。**平文はここでしか出てこない。** */
export interface ReissuedClaim {
  readonly claim_url: string;
  /** 受取権ID。どの受取ぶんの URL かを画面で示すために返す。 */
  readonly entitlement_id: string;
}

/** 現在のハッシュを引ける実装であること（差し替えの条件に使う）。 */
export interface ClaimTokenRotationSource extends ClaimRepositoryPort {
  currentTokenHash(entitlementId: string): Promise<string | null>;
}

/**
 * 受取URLの再発行。
 *
 * ⚠️ **平文のトークンをログ・監査・イベントへ出さない。**
 * 保存しているのはハッシュだけ、という設計の意味が消える。
 * 監査に残すのは「誰がいつどの受取権を再発行したか」まで。
 */
@Injectable()
export class ReissueService {
  constructor(
    private readonly claims: ClaimTokenRotationSource,
    private readonly tokens: ClaimTokenPort,
    private readonly clock: ClockPort,
    private readonly audit: AuditLogPort,
    /** 受取ページの前置き。末尾のスラッシュは含めない。 */
    private readonly claimBaseUrl: string,
  ) {}

  async reissue(entitlementId: string, actor: Actor): Promise<ReissuedClaim> {
    const entitlement = await this.claims.findForReissue(entitlementId);
    if (entitlement === null) {
      // ⚠️ 存在しないことと、他人のものであることを区別して答えない。
      //    区別すると、IDを総当たりして「実在するか」を調べられる。
      throw new DomainErrorException('ENTITLEMENT_OWNER_MISMATCH');
    }

    const decision = evaluateReissue({
      entitlement,
      actorAccountId: actor.accountId,
      now: this.clock.now(),
    });
    if (!decision.ok) {
      throw new DomainErrorException(decision.error.code);
    }

    const expectedTokenHash = await this.claims.currentTokenHash(entitlementId);
    if (expectedTokenHash === null) {
      throw new DomainErrorException('ENTITLEMENT_OWNER_MISMATCH');
    }

    const issued = this.tokens.issue();
    const rotated = await this.claims.rotateClaimToken({
      entitlementId,
      accountId: entitlement.accountId,
      expectedTokenHash,
      newTokenHash: issued.tokenHash,
      now: this.clock.now(),
    });

    if (!rotated) {
      // ⚠️ **書けなかったトークンを「発行できました」と返さない。**
      //    同時に走ったもう一方が先に差し替えており、こちらの URL は
      //    作られた瞬間から無効。渡せば「開かない URL」を掴ませることになる。
      const body: ApiError = {
        error: {
          code: 'IDEMPOTENCY_CONFLICT',
          message: '同じ操作を処理中です。しばらくしてからお試しください。',
        },
      };
      throw new ConflictException(body);
    }

    // ⚠️ 平文を含めない。残すのは「誰がいつ何を再発行したか」まで。
    await this.audit.record({
      actorAccountId: actor.accountId,
      action: 'claim_token.reissued',
      targetType: 'entitlement',
      targetId: entitlementId,
      summary: { reason: 'purchaser_requested' },
    });

    return {
      claim_url: `${this.claimBaseUrl}/${issued.token}`,
      entitlement_id: entitlementId,
    };
  }
}
