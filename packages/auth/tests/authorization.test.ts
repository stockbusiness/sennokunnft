import { describe, expect, it } from 'vitest';
import {
  ACTIONS,
  ROLES,
  ANONYMOUS,
  can,
  isAllowed,
  type Action,
  type Actor,
  type Role,
} from '../src/index';

const SELF = 'account-self';
const OTHER = 'account-other';

function actor(role: Role, overrides: Partial<Actor> = {}): Actor {
  if (role === 'anonymous') {
    return { ...ANONYMOUS, ...overrides };
  }
  return { role, accountId: SELF, isActive: true, ...overrides };
}

/**
 * AUTHORIZATION_DESIGN.md §2.3 の権限マトリクスを、そのまま表として写したもの。
 * 自分が所有するリソースに対する判定を記す（TEST_STRATEGY §3.6 Z-1）。
 */
const MATRIX: Readonly<Record<Action, Readonly<Record<Role, boolean>>>> = {
  'artwork.view_public': { anonymous: true, buyer: true, operator: true, auditor: true },
  'artwork.view_unpublished': { anonymous: false, buyer: false, operator: true, auditor: true },
  'artwork.manage': { anonymous: false, buyer: false, operator: true, auditor: false },
  'listing.manage': { anonymous: false, buyer: false, operator: true, auditor: false },
  'order.create': { anonymous: false, buyer: true, operator: false, auditor: false },
  'order.view': { anonymous: false, buyer: true, operator: true, auditor: true },
  'order.view_any': { anonymous: false, buyer: false, operator: true, auditor: true },
  'checkout.create': { anonymous: false, buyer: true, operator: false, auditor: false },
  'claim.inspect': { anonymous: false, buyer: true, operator: false, auditor: false },
  'claim.accept': { anonymous: false, buyer: true, operator: false, auditor: false },
  'collection.view': { anonymous: false, buyer: true, operator: true, auditor: true },
  'mint_job.retry': { anonymous: false, buyer: false, operator: true, auditor: false },
  'audit_log.view': { anonymous: false, buyer: false, operator: true, auditor: true },
};

describe('権限マトリクスの全セル検証（Z-1）', () => {
  for (const action of ACTIONS) {
    for (const role of ROLES) {
      const expected = MATRIX[action][role];
      it(`${role} × ${action} → ${expected ? '許可' : '拒否'}`, () => {
        expect(isAllowed(actor(role), action, { ownerAccountId: SELF })).toBe(expected);
      });
    }
  }

  it('マトリクスが全アクションを網羅している（定義漏れ検出）', () => {
    expect(Object.keys(MATRIX).sort()).toEqual([...ACTIONS].sort());
  });
});

describe('所有権チェック（IDOR 対策）', () => {
  it('他人の注文は buyer には見せない（Z-2）', () => {
    const decision = can(actor('buyer'), 'order.view', { ownerAccountId: OTHER });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('expected deny');
    expect(decision.reason).toBe('not_owner');
  });

  it('operator は広域権限を持つので他人の注文も見られる', () => {
    expect(isAllowed(actor('operator'), 'order.view', { ownerAccountId: OTHER })).toBe(true);
  });

  it('所有者が不明なリソースは拒否する（既定 deny）', () => {
    expect(isAllowed(actor('buyer'), 'order.view', {})).toBe(false);
    expect(isAllowed(actor('buyer'), 'order.view', { ownerAccountId: null })).toBe(false);
  });

  it('受取の実行は運営でも代行できない（購入者本人のみ）', () => {
    // 運営に代行させると「誰が受け取ったか」が曖昧になるため、
    // UD-804 が決まるまでは経路自体を作らない。
    expect(isAllowed(actor('operator'), 'claim.accept', { ownerAccountId: OTHER })).toBe(false);
    expect(isAllowed(actor('operator'), 'claim.accept', { ownerAccountId: SELF })).toBe(false);
  });

  it('自分のコレクションのみ閲覧できる', () => {
    expect(isAllowed(actor('buyer'), 'collection.view', { ownerAccountId: SELF })).toBe(true);
    expect(isAllowed(actor('buyer'), 'collection.view', { ownerAccountId: OTHER })).toBe(false);
    // 運営も他人のコレクションは直接見ない（/admin/entitlements = order.view_any を使う）。
    expect(isAllowed(actor('operator'), 'collection.view', { ownerAccountId: OTHER })).toBe(false);
  });
});

describe('アカウント状態', () => {
  it('停止中のアカウントはすべて拒否される', () => {
    const suspended = actor('buyer', { isActive: false });
    for (const action of ACTIONS) {
      const decision = can(suspended, action, { ownerAccountId: SELF });
      expect(decision.allowed).toBe(false);
      if (decision.allowed) throw new Error('expected deny');
      expect(decision.reason).toBe('inactive_account');
    }
  });

  it('ロールはあるがアカウントIDがない場合は未認証として拒否する', () => {
    const decision = can(actor('buyer', { accountId: null }), 'order.create');
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('expected deny');
    expect(decision.reason).toBe('unauthenticated');
  });
});

describe('管理操作（Z-5）', () => {
  it.each(['artwork.manage', 'listing.manage', 'mint_job.retry'] as const)(
    'buyer は %s を実行できない',
    (action) => {
      expect(isAllowed(actor('buyer'), action)).toBe(false);
    },
  );

  it('auditor は読み取りのみで、状態を変える操作はできない', () => {
    const writeActions: Action[] = [
      'artwork.manage',
      'listing.manage',
      'order.create',
      'checkout.create',
      'claim.accept',
      'mint_job.retry',
    ];
    for (const action of writeActions) {
      expect(isAllowed(actor('auditor'), action, { ownerAccountId: SELF })).toBe(false);
    }
  });
});
