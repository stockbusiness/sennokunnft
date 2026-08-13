import { domainError, type DomainError } from '../shared/errors';
import { err, ok, type Result } from '../shared/result';
import type { EntitlementStatus } from '../state/machines';

/** Claim 判定に必要な受取権の情報（永続化の詳細は含まない）。 */
export interface ClaimableEntitlement {
  readonly id: string;
  /** 購入者のアカウントID。Claim できるのは原則この本人のみ（UD-804）。 */
  readonly accountId: string;
  readonly status: EntitlementStatus;
  /** Claim 期限。`null` は無期限（UD-505 で未決定のため MVP は無期限）。 */
  readonly expiresAt: Date | null;
}

export interface ClaimAttempt {
  readonly entitlement: ClaimableEntitlement;
  /** Claim を実行しようとしている認証済みアカウント。未認証なら `null`。 */
  readonly actorAccountId: string | null;
  /** アクターのアカウントが有効か。停止中のアカウントには受け取らせない。 */
  readonly actorIsActive: boolean;
  /** 提示された Claim トークンのハッシュが保存値と一致したか。 */
  readonly tokenMatches: boolean;
  readonly now: Date;
}

/**
 * Claim の可否を判定する（AUTHORIZATION_DESIGN.md §2.4）。
 *
 * ここは純粋関数であり、DB も HTTP も知らない。
 * **実際の排他制御は本関数では担保できない**。同時実行に対する一意性は、
 * `WHERE status = 'issued'` の条件付き UPDATE の更新行数で判定する
 * （INV-E1 / LAZY_MINT_FLOW.md §3.4）。
 * 本関数はその手前で、明らかに不可能な要求を早期に弾くためにある。
 *
 * 判定順序には意味がある。トークン不一致を最優先で 404 相当にすることで、
 * 「有効なトークンが存在するか」を攻撃者に推測させない。
 */
export function evaluateClaim(attempt: ClaimAttempt): Result<ClaimableEntitlement, DomainError> {
  const { entitlement, actorAccountId, actorIsActive, tokenMatches, now } = attempt;

  // 1. トークン一致。存在の有無を漏らさないため最初に判定する。
  if (!tokenMatches) {
    return err(domainError('CLAIM_TOKEN_INVALID', 'claim token does not match'));
  }

  // 2. 未認証。認証だけで解決できるので、状態の詳細より先に返す。
  if (actorAccountId === null) {
    return err(domainError('ENTITLEMENT_OWNER_MISMATCH', 'authentication required'));
  }

  // 3. 受取権が受け取り可能な状態か。
  if (entitlement.status !== 'issued') {
    return err(domainError('ENTITLEMENT_NOT_CLAIMABLE', `status is ${entitlement.status}`));
  }

  // 4. 期限内か。
  if (entitlement.expiresAt !== null && entitlement.expiresAt.getTime() <= now.getTime()) {
    return err(domainError('ENTITLEMENT_NOT_CLAIMABLE', 'claim period has expired'));
  }

  // 5. 購入者本人か。トークンを持っているだけでは受け取らせない。
  //    URL が漏れた場合に第三者へ渡らないようにするための、最も重要な条件。
  if (entitlement.accountId !== actorAccountId) {
    return err(domainError('ENTITLEMENT_OWNER_MISMATCH', 'actor is not the purchaser'));
  }

  // 6. アカウントが有効か。
  if (!actorIsActive) {
    return err(domainError('ENTITLEMENT_OWNER_MISMATCH', 'account is not active'));
  }

  return ok(entitlement);
}

/**
 * 発行ジョブの冪等キーの元になる文字列。
 *
 * **受取権IDから決定論的に導出する**ことが要点。
 * 再試行のたびに新しいキーを作ると、外部の発行APIから見て別依頼になり、
 * 多重発行の原因になる（LAZY_MINT_FLOW.md §3.4）。
 *
 * 実際の HMAC 計算は `@sengoku/integrations` が行う（暗号処理はドメインの責務ではない）。
 */
export function mintIdempotencyPayload(entitlementId: string): string {
  return `mint:v1:${entitlementId}`;
}
