import { domainError, type DomainError } from '../shared/errors';
import { err, ok, type Result } from '../shared/result';
import type { EntitlementStatus } from '../state/machines';
import {
  toPublicClaimStatus,
  type PublicClaimStatus,
  type WalletDeliveryStatus,
} from './claim-status';

/**
 * OVEW Wallet からの Claim 判定（API_DESIGN.md §3-2）。
 *
 * ⚠️ **既存の `evaluateClaim` とは別物。混ぜない。**
 * あちらは「本システムにログイン済みのアカウント」が受け取る経路で、
 * 本人性を `account_id` で見る。こちらは Wallet が代理で呼ぶ経路で、
 * 本人性を **`common_user_id`** で見る。
 * 同じ関数に押し込めると、片方の緩い条件がもう片方へ漏れる。
 *
 * ⚠️ **`common_user_id` は識別子であって資格情報ではない。**
 * 本文に載ってくる自己申告の値なので、これ単体では本人確認にならない。
 * 呼び出し元が OVEW Wallet であることは **HMAC 署名の検証**で確かめる。
 * 署名の検証を通っていない要求を、この関数へ渡してはいけない。
 */

/** Claim 判定に必要な受取権の情報（永続化の詳細を含まない）。 */
export interface WalletClaimableEntitlement {
  readonly id: string;
  readonly status: EntitlementStatus;
  readonly deliveryStatus: WalletDeliveryStatus;
  /** Claim 期限。`null` は無期限（`UD-505` 未決定のため MVP は `null`）。 */
  readonly expiresAt: Date | null;
  /**
   * 購入者の `common_user_id`。
   *
   * `null` は「まだ解決できていない」。**購入者が居ないという意味ではない。**
   */
  readonly purchaserCommonUserId: string | null;
  /** 既に受け取り済みなら、受け取った `common_user_id`。 */
  readonly claimedByCommonUserId: string | null;
}

export interface WalletClaimAttempt {
  readonly entitlement: WalletClaimableEntitlement;
  /** 要求の本文で提示された `common_user_id`。 */
  readonly presentedCommonUserId: string;
  readonly now: Date;
}

/** 判定の結果。**「受理」と「保留」を別物として扱う。** */
export type WalletClaimDecision =
  /** 受理してよい。呼び出し元が条件付き UPDATE で確定させる。 */
  | { readonly kind: 'proceed' }
  /**
   * 購入者の `common_user_id` がまだ解決していない。
   *
   * ⚠️ **これは失敗ではない。** 受取権を失効させず、解決後にもう一度 Claim できる。
   * HTTP は `202`、公開状態は `PENDING`（回答書 §11）。
   */
  | { readonly kind: 'pending_common_user' }
  /** 既にこの本人が受け取り済み。再送に対して同じ答えを返すために使う。 */
  | { readonly kind: 'already_claimed'; readonly status: PublicClaimStatus };

/**
 * Claim の可否を判定する。
 *
 * ⚠️ **判定の順序に意味がある。**
 * トークンの不一致は呼び出し元が先に弾く（存在を漏らさないため）。
 * ここでは終端状態 → 未解決 → 本人性 → 受理済み、の順に見る。
 * 本人性より先に終端状態を見るのは、失効済みの受取権について
 * 「誰のものだったか」を問い合わせられないようにするため。
 */
export function evaluateWalletClaim(
  attempt: WalletClaimAttempt,
): Result<WalletClaimDecision, DomainError> {
  const { entitlement, presentedCommonUserId, now } = attempt;

  // 1. 取り消し済み。管理者が意図して止めた状態なので、期限より先に見る。
  if (entitlement.status === 'revoked') {
    return err(domainError('CLAIM_REVOKED', 'entitlement has been revoked'));
  }

  // 2. 期限切れ。状態として記録済みの場合と、時刻が過ぎただけの場合の両方を見る。
  //    後者を見落とすと、掃除が走るまでのあいだ期限切れを受け付けてしまう。
  const pastDue =
    entitlement.expiresAt !== null && entitlement.expiresAt.getTime() <= now.getTime();
  if (entitlement.status === 'expired' || pastDue) {
    return err(domainError('CLAIM_EXPIRED', 'claim period has expired'));
  }

  // 3. 購入者の common_user_id が未解決。
  //    ⚠️ 本人性の判定より**先**。比べる相手がまだ無いので、
  //    ここを飛ばすと「未解決」を「不一致」と誤って答えてしまう。
  //    不一致は 409 の失敗だが、未解決は 202 の保留。意味がまるで違う。
  if (entitlement.purchaserCommonUserId === null) {
    return ok({ kind: 'pending_common_user' });
  }

  // 4. 本人か。トークンを持っているだけでは受け取らせない。
  if (entitlement.purchaserCommonUserId !== presentedCommonUserId) {
    return err(domainError('COMMON_USER_MISMATCH', 'presented common user is not the purchaser'));
  }

  // 5. 受理済みなら、同じ答えを返す（再送に強くする）。
  if (entitlement.status === 'claimed') {
    if (entitlement.claimedByCommonUserId !== presentedCommonUserId) {
      // 購入者本人なのに別人が受け取っている。データの矛盾なので受理しない。
      return err(domainError('COMMON_USER_MISMATCH', 'entitlement was claimed by another user'));
    }
    return ok({
      kind: 'already_claimed',
      status: toPublicClaimStatus(entitlement.status, entitlement.deliveryStatus),
    });
  }

  return ok({ kind: 'proceed' });
}
