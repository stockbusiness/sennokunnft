import { describe, expect, it } from 'vitest';
import {
  evaluateClaim,
  mintIdempotencyPayload,
  type ClaimAttempt,
  type ClaimableEntitlement,
} from '../src/index';

const NOW = new Date('2026-01-01T00:00:00.000Z');
const BUYER = 'account-buyer';
const OTHER = 'account-other';

function entitlement(overrides: Partial<ClaimableEntitlement> = {}): ClaimableEntitlement {
  return {
    id: 'entitlement-1',
    accountId: BUYER,
    status: 'issued',
    expiresAt: null,
    ...overrides,
  };
}

function attempt(overrides: Partial<ClaimAttempt> = {}): ClaimAttempt {
  return {
    entitlement: entitlement(),
    actorAccountId: BUYER,
    actorIsActive: true,
    tokenMatches: true,
    now: NOW,
    ...overrides,
  };
}

describe('evaluateClaim（AUTHORIZATION_DESIGN §2.4）', () => {
  it('購入者本人・有効なトークン・issued なら受け取れる', () => {
    expect(evaluateClaim(attempt()).ok).toBe(true);
  });

  it('トークンが一致しなければ拒否する', () => {
    const result = evaluateClaim(attempt({ tokenMatches: false }));
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('CLAIM_TOKEN_INVALID');
  });

  it('トークン不一致は、受取権の状態より先に判定される（存在を漏らさない）', () => {
    // 状態が revoked でも、返るのは CLAIM_TOKEN_INVALID でなければならない。
    // 状態別のエラーを返すと「そのトークンは実在する」と教えてしまう。
    const result = evaluateClaim(
      attempt({ tokenMatches: false, entitlement: entitlement({ status: 'revoked' }) }),
    );
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('CLAIM_TOKEN_INVALID');
  });

  it('未認証では受け取れない（Z-4）', () => {
    const result = evaluateClaim(attempt({ actorAccountId: null }));
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('ENTITLEMENT_OWNER_MISMATCH');
  });

  it('購入者と異なるアカウントでは受け取れない（Z-3）', () => {
    // Claim URL が漏れても第三者に渡らないことを担保する、最も重要な条件。
    const result = evaluateClaim(attempt({ actorAccountId: OTHER }));
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('ENTITLEMENT_OWNER_MISMATCH');
  });

  it('停止中のアカウントでは受け取れない', () => {
    const result = evaluateClaim(attempt({ actorIsActive: false }));
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('ENTITLEMENT_OWNER_MISMATCH');
  });

  it.each(['claimed', 'expired', 'revoked'] as const)('%s の受取権は受け取れない', (status) => {
    const result = evaluateClaim(attempt({ entitlement: entitlement({ status }) }));
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('ENTITLEMENT_NOT_CLAIMABLE');
  });

  it('期限を過ぎた受取権は受け取れない', () => {
    const result = evaluateClaim(
      attempt({
        entitlement: entitlement({ expiresAt: new Date(NOW.getTime() - 1) }),
      }),
    );
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('ENTITLEMENT_NOT_CLAIMABLE');
  });

  it('期限ちょうどは受け取れない（境界）', () => {
    const result = evaluateClaim(attempt({ entitlement: entitlement({ expiresAt: NOW }) }));
    expect(result.ok).toBe(false);
  });

  it('期限内なら受け取れる', () => {
    const result = evaluateClaim(
      attempt({ entitlement: entitlement({ expiresAt: new Date(NOW.getTime() + 1000) }) }),
    );
    expect(result.ok).toBe(true);
  });

  it('エラーの detail に Claim トークンが含まれない', () => {
    const result = evaluateClaim(attempt({ tokenMatches: false }));
    if (result.ok) throw new Error('expected failure');
    expect(JSON.stringify(result.error)).not.toContain('token-');
  });
});

describe('mintIdempotencyPayload（I-7）', () => {
  it('同じ受取権IDからは常に同じ値が導出される', () => {
    // 再試行のたびに変わると、外部から見て別依頼になり多重発行の原因になる。
    expect(mintIdempotencyPayload('e-1')).toBe(mintIdempotencyPayload('e-1'));
  });

  it('異なる受取権IDでは異なる値になる', () => {
    expect(mintIdempotencyPayload('e-1')).not.toBe(mintIdempotencyPayload('e-2'));
  });
});
