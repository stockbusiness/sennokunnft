import { describe, expect, it } from 'vitest';
import { evaluateAutoDelivery } from '../src/entitlement/auto-delivery';
import type { WalletClaimableEntitlement } from '../src/entitlement/wallet-claim';

/**
 * Wallet への自動配送（P0-2）。
 *
 * ⚠️ ここで守りたいのは 3 つ。
 *   1. **登録済みの方には、待たせずに届けること。**
 *   2. **登録していない方を、失敗として扱わないこと。** 登録が済めば届く。
 *   3. **「誰として受け取るか」を外から決められないこと。** 使うのは
 *      受取権に記録された購入者ご本人の値だけ。
 */

const NOW = new Date('2026-08-20T00:00:00.000Z');
const CU = 'cu_' + 'a'.repeat(32);

function entitlement(
  overrides: Partial<WalletClaimableEntitlement> = {},
): WalletClaimableEntitlement {
  return {
    id: 'ent-1',
    status: 'issued',
    deliveryStatus: 'not_started',
    expiresAt: null,
    purchaserCommonUserId: CU,
    claimedByCommonUserId: null,
    ...overrides,
  };
}

describe('届けてよいとき', () => {
  it('受取用のウォレットが結び付いていれば届ける', () => {
    const decision = evaluateAutoDelivery(entitlement(), NOW);
    expect(decision.kind).toBe('proceed');
  });

  it('届け先は、受取権に記録された購入者ご本人の値', () => {
    /*
      ⚠️ **ここが要。** 届け先を引数で渡せる形にすると、そこが他人の
         Wallet へ届ける道になる。使うのは記録された値だけ。
    */
    const decision = evaluateAutoDelivery(entitlement(), NOW);
    expect(decision.kind === 'proceed' && decision.commonUserId).toBe(CU);
  });
});

describe('いま届けないとき', () => {
  it('ウォレット未登録は「失敗」にしない', () => {
    // ⚠️ 登録が済めば次の掃き出しが拾う。失敗として数えると監視が赤くなる。
    const decision = evaluateAutoDelivery(entitlement({ purchaserCommonUserId: null }), NOW);
    expect(decision).toEqual({ kind: 'skip', reason: 'wallet_not_registered' });
  });

  it('すでに受け取り済みなら二度送らない', () => {
    const decision = evaluateAutoDelivery(
      entitlement({ status: 'claimed', claimedByCommonUserId: CU, deliveryStatus: 'delivered' }),
      NOW,
    );
    expect(decision).toEqual({ kind: 'skip', reason: 'already_delivered' });
  });

  it('取り消し済みは自動で動かさない（人の判断へ回す）', () => {
    const decision = evaluateAutoDelivery(entitlement({ status: 'revoked' }), NOW);
    expect(decision).toEqual({ kind: 'skip', reason: 'not_deliverable' });
  });

  it('期限切れは自動で動かさない', () => {
    const decision = evaluateAutoDelivery(
      entitlement({ expiresAt: new Date(NOW.getTime() - 1) }),
      NOW,
    );
    expect(decision).toEqual({ kind: 'skip', reason: 'not_deliverable' });
  });

  it('状態として期限切れになっている行も止める', () => {
    const decision = evaluateAutoDelivery(entitlement({ status: 'expired' }), NOW);
    expect(decision).toEqual({ kind: 'skip', reason: 'not_deliverable' });
  });
});

describe('人が受け取りに来たときと同じ判定を通す', () => {
  it('別人が受け取っている行は届けない（記録の矛盾）', () => {
    /*
      ⚠️ 購入者ご本人の値で判定しているので、別人が受け取っている行は
         `evaluateWalletClaim` 側で不一致になる。自動の経路だけ緩めない。
    */
    const decision = evaluateAutoDelivery(
      entitlement({ status: 'claimed', claimedByCommonUserId: 'cu_' + 'b'.repeat(32) }),
      NOW,
    );
    expect(decision).toEqual({ kind: 'skip', reason: 'not_deliverable' });
  });

  it('例外を投げない（1 件の異常で残りを止めない）', () => {
    for (const status of ['issued', 'claimed', 'expired', 'revoked'] as const) {
      expect(() => evaluateAutoDelivery(entitlement({ status }), NOW)).not.toThrow();
    }
  });
});
