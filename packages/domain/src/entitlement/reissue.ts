import { domainError, type DomainError } from '../shared/errors';
import { err, ok, type Result } from '../shared/result';
import type { EntitlementStatus } from '../state/machines';

/**
 * 受取URL（Claim Token）の再発行（`SECURITY_DESIGN.md` §8.1 / `UD-1009`）。
 *
 * ⚠️ **「再表示」ではなく「再発行」。**
 * 平文のトークンは保存していないので、失った URL をもう一度見せることはできない。
 * できるのは、**古いものを失効させて新しいものを作る**ことだけ。
 *
 * ⚠️ **古い URL を必ず失効させる。**
 * 新しい URL を出すだけで古い方を生かしておくと、
 * **漏れた URL がそのまま有効な受取口として残る。**
 * 再発行は「経路を足す」操作ではなく「経路を差し替える」操作。
 */

export interface ReissuableEntitlement {
  readonly id: string;
  /** 購入者のアカウントID。再発行できるのは本人だけ。 */
  readonly accountId: string;
  readonly status: EntitlementStatus;
  readonly expiresAt: Date | null;
}

export interface ReissueAttempt {
  readonly entitlement: ReissuableEntitlement;
  /** 再発行を求めている認証済みアカウント。未認証なら `null`。 */
  readonly actorAccountId: string | null;
  readonly now: Date;
}

/**
 * 再発行してよいかを判定する。
 *
 * ⚠️ **判定の順序に意味がある。**
 * 本人でないことを、状態より先に返す。順序が逆だと、
 * 他人の受取権について「それは受取済みです」「期限切れです」と
 * 答えることになり、**持っていない受取権の状態を探れてしまう。**
 */
export function evaluateReissue(
  attempt: ReissueAttempt,
): Result<ReissuableEntitlement, DomainError> {
  const { entitlement, actorAccountId, now } = attempt;

  // 1. 本人か。状態を答える前に確かめる。
  if (actorAccountId === null || entitlement.accountId !== actorAccountId) {
    return err(domainError('ENTITLEMENT_OWNER_MISMATCH', 'actor is not the purchaser'));
  }

  // 2. まだ受け取っていないものだけ。
  //    ⚠️ 受取済みのものを再発行できると、**一度受け取ったあとに
  //    もう一度受け取れる経路**を作ることになる。
  if (entitlement.status !== 'issued') {
    return err(domainError('ENTITLEMENT_NOT_CLAIMABLE', `status is ${entitlement.status}`));
  }

  // 3. 期限内か。期限切れに新しい URL を出しても受け取れず、
  //    「発行できたのに使えない」という分かりにくい状態になる。
  if (entitlement.expiresAt !== null && entitlement.expiresAt.getTime() <= now.getTime()) {
    return err(domainError('CLAIM_EXPIRED', 'claim period has expired'));
  }

  return ok(entitlement);
}
