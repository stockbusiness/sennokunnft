import { describe, expect, it } from 'vitest';
import {
  REVOCATION_EVENT_ID_PREFIX,
  decideRevocation,
  entitlementStateMachine,
  fallbackRevocationCorrelationId,
  revocableEntitlementStatuses,
  revocationEventId,
  type RevocationTarget,
} from '../src/index';

/**
 * 全額返金にともなう取り消し（`UD-104` 追補・2026-08-20 決定）。
 *
 * ⚠️ ここで確かめるのは「誰に何を送るか」の判断だけ。
 * 実際に積む・送るは外側の責務。
 */

const ENTITLEMENT_ID = '3f2b1c8e-0d44-4a91-9d1e-7c5a2b6f0e13';
const ORDER_ID = '8c1d2e3f-4a5b-6c7d-8e9f-0a1b2c3d4e5f';
const COMMON_USER_ID = 'cu_9a1f0c3b7d8e2f4a5b6c7d8e9f0a1b2c';
const OTHER_COMMON_USER_ID = 'cu_1111111111111111111111111111ffff';

function target(overrides: Partial<RevocationTarget> = {}): RevocationTarget {
  return {
    entitlementId: ENTITLEMENT_ID,
    orderId: ORDER_ID,
    hasGrantedEvent: true,
    grantedCommonUserId: COMMON_USER_ID,
    claimedCommonUserId: COMMON_USER_ID,
    grantedCorrelationId: 'ord-legacy-correlation',
    ...overrides,
  };
}

describe('受取権の状態遷移', () => {
  it('全額返金のために claimed から revoked へ進める', () => {
    expect(entitlementStateMachine.canTransition('claimed', 'revoked')).toBe(true);
  });

  it('未受取からの取り消しは従来どおり通る', () => {
    expect(entitlementStateMachine.canTransition('issued', 'revoked')).toBe(true);
  });

  it.each([
    ['claimed', 'issued'],
    ['claimed', 'expired'],
    ['revoked', 'issued'],
    ['revoked', 'claimed'],
    ['revoked', 'expired'],
  ] as const)('%s から %s へは戻さない', (from, to) => {
    // ⚠️ `revoked` は終端。再付与は新しい受取権を作ることで行う。
    expect(entitlementStateMachine.canTransition(from, to)).toBe(false);
  });
});

describe('取り消してよい状態', () => {
  it('既定では未受取だけを取り消す', () => {
    expect(revocableEntitlementStatuses(false)).toEqual(['issued']);
  });

  it('有効にすると受取済みも対象になる', () => {
    expect(revocableEntitlementStatuses(true)).toEqual(['issued', 'claimed']);
  });

  it('期限切れは対象にしない', () => {
    // ⚠️ 期限切れは取り消しとは別の終わり方。上書きすると理由が失われる。
    expect(revocableEntitlementStatuses(true)).not.toContain('expired');
  });
});

describe('イベントIDの決め方', () => {
  it('同じ受取権なら何度呼んでも同じ値になる', () => {
    expect(revocationEventId(ENTITLEMENT_ID)).toBe(revocationEventId(ENTITLEMENT_ID));
  });

  it('受取権IDから決まる（乱数を含まない）', () => {
    expect(revocationEventId(ENTITLEMENT_ID)).toBe(
      `${REVOCATION_EVENT_ID_PREFIX}${ENTITLEMENT_ID}`,
    );
  });

  it('付与イベントの識別子と取り違えない前置きを使う', () => {
    // 付与は `evt_`、取消は `evt_rvk_`。一覧を眺めて種別が分かる。
    expect(revocationEventId(ENTITLEMENT_ID).startsWith('evt_rvk_')).toBe(true);
  });
});

describe('取り消しの宛先', () => {
  it('付与イベントを一度も作っていなければ、相手へは何も送らない', () => {
    // ⚠️ 相手が知らない受取権の取消を送ると、「知らないIDの取消」が届き続ける。
    const decision = decideRevocation(target({ hasGrantedEvent: false }));
    expect(decision.kind).toBe('revoke_only');
  });

  it('付与イベントがあれば、状態を問わず取消を作る', () => {
    const decision = decideRevocation(target());
    expect(decision.kind).toBe('revoke_and_notify');
  });

  it('付与イベントの本文にあった共通顧客IDを正とする', () => {
    /*
      ⚠️ **列より本文を優先する。** 本文は「相手へ実際に伝えた値」。
         食い違っていたときに列を採ると、相手が知らない別人の
         Holding を消しにいく。
    */
    const decision = decideRevocation(
      target({
        grantedCommonUserId: COMMON_USER_ID,
        claimedCommonUserId: OTHER_COMMON_USER_ID,
      }),
    );
    expect(decision).toMatchObject({ kind: 'revoke_and_notify', commonUserId: COMMON_USER_ID });
  });

  it('本文から取れないときだけ、受取権の列を使う', () => {
    const decision = decideRevocation(
      target({ grantedCommonUserId: null, claimedCommonUserId: COMMON_USER_ID }),
    );
    expect(decision).toMatchObject({ kind: 'revoke_and_notify', commonUserId: COMMON_USER_ID });
  });

  it('どちらからも取れなければ、推測せず人の確認へ回す', () => {
    const decision = decideRevocation(
      target({ grantedCommonUserId: null, claimedCommonUserId: null }),
    );
    expect(decision).toEqual({ kind: 'needs_review', reason: 'recipient_unresolved' });
  });

  it('形の壊れた共通顧客IDは採らない', () => {
    // ⚠️ 自社の account id をそのまま入れると、相手は別人の Holding を消す。
    const decision = decideRevocation(
      target({ grantedCommonUserId: 'account-1', claimedCommonUserId: null }),
    );
    expect(decision).toEqual({ kind: 'needs_review', reason: 'recipient_unresolved' });
  });
});

describe('相関IDの引き継ぎ', () => {
  it('付与イベントの相関IDをそのまま使う', () => {
    const decision = decideRevocation(target({ grantedCorrelationId: 'req-abcdefgh' }));
    expect(decision).toMatchObject({ correlationId: 'req-abcdefgh' });
  });

  it('付与イベントに無ければ、注文IDから決定的に作る', () => {
    const decision = decideRevocation(target({ grantedCorrelationId: null }));
    expect(decision).toMatchObject({ correlationId: `ord-${ORDER_ID}` });
  });

  it('形の壊れた相関IDは引き継がず、決定的な値へ落ちる', () => {
    // 改行が混ざると、追跡どころか記録そのものが壊れる。
    const decision = decideRevocation(target({ grantedCorrelationId: 'bad\nvalue' }));
    expect(decision).toMatchObject({ correlationId: `ord-${ORDER_ID}` });
  });

  it('落ちた先の値も乱数を含まない', () => {
    expect(fallbackRevocationCorrelationId(ORDER_ID)).toBe(
      fallbackRevocationCorrelationId(ORDER_ID),
    );
  });

  it('同じ注文の取り消しは同じ相関IDになる', () => {
    // 1 回の返金で取り消した全件が、返金 1 件として辿れる。
    const first = decideRevocation(target({ grantedCorrelationId: null }));
    const second = decideRevocation(
      target({ entitlementId: 'other-entitlement', grantedCorrelationId: null }),
    );
    expect(first).toMatchObject({ correlationId: `ord-${ORDER_ID}` });
    expect(second).toMatchObject({ correlationId: `ord-${ORDER_ID}` });
  });
});
