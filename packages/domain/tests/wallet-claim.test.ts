import { describe, expect, it } from 'vitest';
import {
  PUBLIC_CLAIM_STATUSES,
  evaluateWalletClaim,
  toPublicClaimStatus,
  type WalletClaimableEntitlement,
} from '../src';

const NOW = new Date('2026-08-14T00:00:00Z');
const PURCHASER = 'cu_0123456789abcdef0123456789abcdef';
const OTHER = 'cu_fedcba9876543210fedcba9876543210';

function entitlement(
  overrides: Partial<WalletClaimableEntitlement> = {},
): WalletClaimableEntitlement {
  return {
    id: 'ent-1',
    status: 'issued',
    deliveryStatus: 'not_started',
    expiresAt: null,
    purchaserCommonUserId: PURCHASER,
    claimedByCommonUserId: null,
    ...overrides,
  };
}

function attempt(e: WalletClaimableEntitlement, presented = PURCHASER) {
  return evaluateWalletClaim({ entitlement: e, presentedCommonUserId: presented, now: NOW });
}

describe('公開状態への写像（UD-1007: 公開は 5 値のみ）', () => {
  it('公開する状態は 5 つだけ', () => {
    expect(PUBLIC_CLAIM_STATUSES).toEqual([
      'PENDING',
      'DELIVERY_PENDING',
      'DELIVERED',
      'EXPIRED',
      'REVOKED',
    ]);
  });

  it('未受取は PENDING', () => {
    expect(toPublicClaimStatus('issued', 'not_started')).toBe('PENDING');
  });

  it('受取済みでも届いていなければ DELIVERY_PENDING', () => {
    // ここを DELIVERED にすると、配送が失敗しても相手には成功に見える。
    expect(toPublicClaimStatus('claimed', 'not_started')).toBe('DELIVERY_PENDING');
    expect(toPublicClaimStatus('claimed', 'pending')).toBe('DELIVERY_PENDING');
  });

  it('届いてはじめて DELIVERED', () => {
    expect(toPublicClaimStatus('claimed', 'delivered')).toBe('DELIVERED');
  });

  it('期限切れ・取り消しはそのまま伝える', () => {
    expect(toPublicClaimStatus('expired', 'not_started')).toBe('EXPIRED');
    expect(toPublicClaimStatus('revoked', 'not_started')).toBe('REVOKED');
  });

  it('内部状態が何であれ、5 値の外へ出ない', () => {
    const internal = ['issued', 'claimed', 'expired', 'revoked'] as const;
    const delivery = ['not_started', 'pending', 'delivered'] as const;
    for (const s of internal) {
      for (const d of delivery) {
        expect(PUBLIC_CLAIM_STATUSES).toContain(toPublicClaimStatus(s, d));
      }
    }
  });
});

describe('Wallet からの Claim 判定', () => {
  it('購入者本人なら受理してよい', () => {
    const result = attempt(entitlement());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.kind).toBe('proceed');
  });

  it('取り消し済みは CLAIM_REVOKED', () => {
    const result = attempt(entitlement({ status: 'revoked' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('CLAIM_REVOKED');
  });

  it('期限切れの状態は CLAIM_EXPIRED', () => {
    const result = attempt(entitlement({ status: 'expired' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('CLAIM_EXPIRED');
  });

  it('状態が issued でも、期限を過ぎていれば CLAIM_EXPIRED', () => {
    // 掃除が走る前でも受け付けない。時刻の経過だけで失効する。
    const result = attempt(entitlement({ expiresAt: new Date('2026-08-13T23:59:59Z') }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('CLAIM_EXPIRED');
  });

  it('期限ちょうどは失効として扱う（境界）', () => {
    const result = attempt(entitlement({ expiresAt: NOW }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('CLAIM_EXPIRED');
  });

  it('取り消しは期限切れより先に判定する', () => {
    const result = attempt(
      entitlement({ status: 'revoked', expiresAt: new Date('2026-08-13T00:00:00Z') }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('CLAIM_REVOKED');
  });

  describe('購入者の common_user_id が未解決のとき', () => {
    it('失敗ではなく保留を返す', () => {
      const result = attempt(entitlement({ purchaserCommonUserId: null }));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.kind).toBe('pending_common_user');
    });

    it('不一致（COMMON_USER_MISMATCH）にしない', () => {
      // 比べる相手がまだ無いだけ。ここを不一致にすると、
      // 解決を待てば受け取れるはずの人を、失敗として追い返してしまう。
      const result = attempt(entitlement({ purchaserCommonUserId: null }), OTHER);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.kind).toBe('pending_common_user');
    });

    it('取り消し・期限切れのほうが優先される', () => {
      const revoked = attempt(entitlement({ purchaserCommonUserId: null, status: 'revoked' }));
      expect(revoked.ok).toBe(false);
      const expired = attempt(entitlement({ purchaserCommonUserId: null, status: 'expired' }));
      expect(expired.ok).toBe(false);
    });
  });

  it('別人が提示すれば COMMON_USER_MISMATCH', () => {
    const result = attempt(entitlement(), OTHER);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('COMMON_USER_MISMATCH');
  });

  describe('受け取り済みの再送', () => {
    it('同じ本人の再送には、いまの状態をそのまま返す', () => {
      const result = attempt(
        entitlement({
          status: 'claimed',
          deliveryStatus: 'pending',
          claimedByCommonUserId: PURCHASER,
        }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.kind).toBe('already_claimed');
        if (result.value.kind === 'already_claimed') {
          expect(result.value.status).toBe('DELIVERY_PENDING');
        }
      }
    });

    it('配送済みなら DELIVERED を返す', () => {
      const result = attempt(
        entitlement({
          status: 'claimed',
          deliveryStatus: 'delivered',
          claimedByCommonUserId: PURCHASER,
        }),
      );
      expect(result.ok).toBe(true);
      if (result.ok && result.value.kind === 'already_claimed') {
        expect(result.value.status).toBe('DELIVERED');
      }
    });

    it('購入者と受取者が食い違う行は受理しない', () => {
      // データの矛盾。黙って通すと、二重に受け取らせることになる。
      const result = attempt(entitlement({ status: 'claimed', claimedByCommonUserId: OTHER }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('COMMON_USER_MISMATCH');
    });
  });
});
