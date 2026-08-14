import { Injectable } from '@nestjs/common';
import {
  evaluateWalletClaim,
  toPublicClaimStatus,
  type ClaimRepositoryPort,
  type ClaimTokenPort,
  type ClockPort,
  type PublicClaimStatus,
} from '@sengoku/domain';
import { DomainErrorException } from '../common/domain-error.filter';

/** `GET` の応答。✅ **最小形式**（回答書 §11）。画像とシリアルは返さない。 */
export interface ClaimView {
  readonly status: PublicClaimStatus;
  readonly card_name: string;
  readonly expires_at: string | null;
}

/** `POST` の応答。保留のときだけ `reason` が付く。 */
export interface ClaimConfirmation {
  readonly status: PublicClaimStatus;
  readonly reason?: 'common_user_pending';
}

/**
 * Claim（OVEW Wallet 連携）の手続き。
 *
 * ⚠️ **呼び出し元の身元確認は、ここではなく HMAC ガードで行う。**
 * 本サービスへ届く時点で、要求は OVEW Wallet からのものと確かめられている。
 * 本人（購入者）かどうかの判定だけがここの責務。
 */
@Injectable()
export class ClaimService {
  constructor(
    private readonly claims: ClaimRepositoryPort,
    private readonly tokens: ClaimTokenPort,
    private readonly clock: ClockPort,
  ) {}

  /** 受取りの状態を返す。 */
  async view(token: string): Promise<ClaimView> {
    const found = await this.claims.findByTokenHash(this.tokens.hash(token));
    if (found === null) {
      // ⚠️ 「無効」と「存在しない」を区別して答えない。
      //    総当たりで有効なトークンを探せてしまう。
      throw new DomainErrorException('CLAIM_TOKEN_INVALID');
    }
    const { entitlement } = found;
    return {
      status: toPublicClaimStatus(entitlement.status, entitlement.deliveryStatus),
      card_name: found.cardName,
      expires_at: entitlement.expiresAt?.toISOString() ?? null,
    };
  }

  /** 受取りを確定する。 */
  async confirm(token: string, commonUserId: string): Promise<ClaimConfirmation> {
    const found = await this.claims.findByTokenHash(this.tokens.hash(token));
    if (found === null) {
      throw new DomainErrorException('CLAIM_TOKEN_INVALID');
    }

    const decision = evaluateWalletClaim({
      entitlement: found.entitlement,
      presentedCommonUserId: commonUserId,
      now: this.clock.now(),
    });
    if (!decision.ok) {
      throw new DomainErrorException(decision.error.code);
    }

    // 未解決は失敗ではない。受取権を失効させず、解決後にもう一度受け取れる。
    if (decision.value.kind === 'pending_common_user') {
      return { status: 'PENDING', reason: 'common_user_pending' };
    }

    // 再送。すでに確定しているので、いまの状態をそのまま返す。
    if (decision.value.kind === 'already_claimed') {
      return { status: decision.value.status };
    }

    const outcome = await this.claims.confirmClaim({
      entitlementId: found.entitlement.id,
      commonUserId,
      accountId: found.purchaserAccountId,
      now: this.clock.now(),
    });

    if (outcome.kind === 'raced') {
      // ⚠️ 判定から書き込みまでの隙間で、別の要求が確定させた。
      //    読み直して、確定させたのが同じ本人なら成功として答える。
      //    ここで一律に失敗を返すと、再送しただけの相手を落としてしまう。
      const reread = await this.claims.findByTokenHash(this.tokens.hash(token));
      if (
        reread !== null &&
        reread.entitlement.claimedByCommonUserId === commonUserId &&
        reread.entitlement.status === 'claimed'
      ) {
        return {
          status: toPublicClaimStatus(reread.entitlement.status, reread.entitlement.deliveryStatus),
        };
      }
      // 本人以外に取られていた、あるいは終端状態へ移っていた。
      throw new DomainErrorException('CLAIM_PROCESSING');
    }

    // 配送は本 PR では行わない（PR-NW04）。待ち行列へ載せたところまで。
    return { status: 'DELIVERY_PENDING' };
  }
}
