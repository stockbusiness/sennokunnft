import { describe, expect, it } from 'vitest';
import { evaluateReissue, type ReissuableEntitlement } from '../src';

const NOW = new Date('2026-08-14T00:00:00Z');
const OWNER = 'account-owner';
const OTHER = 'account-other';

function entitlement(overrides: Partial<ReissuableEntitlement> = {}): ReissuableEntitlement {
  return { id: 'ent-1', accountId: OWNER, status: 'issued', expiresAt: null, ...overrides };
}

function attempt(e: ReissuableEntitlement, actorAccountId: string | null = OWNER) {
  return evaluateReissue({ entitlement: e, actorAccountId, now: NOW });
}

describe('受取URLの再発行', () => {
  it('購入者本人なら再発行できる', () => {
    expect(attempt(entitlement()).ok).toBe(true);
  });

  it('未認証は拒否する', () => {
    const result = attempt(entitlement(), null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ENTITLEMENT_OWNER_MISMATCH');
  });

  it('別人は拒否する', () => {
    const result = attempt(entitlement(), OTHER);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ENTITLEMENT_OWNER_MISMATCH');
  });

  it('受取済みは再発行できない', () => {
    // ⚠️ できると、一度受け取ったあとにもう一度受け取れる経路ができる。
    const result = attempt(entitlement({ status: 'claimed' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ENTITLEMENT_NOT_CLAIMABLE');
  });

  it('取り消し済みは再発行できない', () => {
    const result = attempt(entitlement({ status: 'revoked' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ENTITLEMENT_NOT_CLAIMABLE');
  });

  it('期限を過ぎていれば再発行できない', () => {
    // 出せても受け取れず、「発行できたのに使えない」状態になる。
    const result = attempt(entitlement({ expiresAt: new Date('2026-08-13T23:59:59Z') }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('CLAIM_EXPIRED');
  });

  describe('他人の受取権について', () => {
    it('状態を問わず、返る理由は同じ', () => {
      // ⚠️ 本人でないことを状態より先に判定する。順序が逆だと、
      //    持っていない受取権について「受取済みです」「期限切れです」と
      //    答えることになり、IDを総当たりして状態を探れてしまう。
      const claimed = attempt(entitlement({ status: 'claimed' }), OTHER);
      const revoked = attempt(entitlement({ status: 'revoked' }), OTHER);
      const expired = attempt(entitlement({ expiresAt: new Date('2026-08-13T00:00:00Z') }), OTHER);
      for (const result of [claimed, revoked, expired]) {
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe('ENTITLEMENT_OWNER_MISMATCH');
      }
    });
  });
});
