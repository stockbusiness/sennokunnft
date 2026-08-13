/**
 * 認可判定。
 *
 * ここは**純粋関数**であり、HTTP も DB も知らない。
 * NestJS の Guard はこの関数を呼ぶだけにする。
 * 純粋関数にすることで、AUTHORIZATION_DESIGN.md §2.3 の権限マトリクスを
 * 表駆動テストで全セル検証できる。
 */

export const ROLES = ['anonymous', 'buyer', 'operator', 'auditor'] as const;
export type Role = (typeof ROLES)[number];

export const ACTIONS = [
  'artwork.view_public',
  'artwork.view_unpublished',
  'artwork.manage',
  'listing.manage',
  'order.create',
  'order.view',
  'order.view_any',
  'checkout.create',
  'claim.inspect',
  'claim.accept',
  'collection.view',
  'mint_job.retry',
  'audit_log.view',
] as const;
export type Action = (typeof ACTIONS)[number];

export interface Actor {
  readonly role: Role;
  /** 認証済みなら内部アカウントID、未認証なら `null`。 */
  readonly accountId: string | null;
  /** アカウントが有効か。停止中は認証済みでも操作させない。 */
  readonly isActive: boolean;
}

/**
 * 操作対象。所有者が定まらない操作（一覧など）では `ownerAccountId` を省略する。
 */
export interface Resource {
  readonly ownerAccountId?: string | null;
}

export const ANONYMOUS: Actor = { role: 'anonymous', accountId: null, isActive: false };

/**
 * ロールごとに許可される操作。
 *
 * **既定は deny。** ここに書かれていない組み合わせはすべて拒否される。
 * 「印を付け忘れたら公開されてしまう」ではなく
 * 「付け忘れたら閉じる」向きにするための構造。
 */
const ROLE_ACTIONS: Readonly<Record<Role, readonly Action[]>> = {
  anonymous: ['artwork.view_public'],
  buyer: [
    'artwork.view_public',
    'order.create',
    'order.view',
    'checkout.create',
    'claim.inspect',
    'claim.accept',
    'collection.view',
  ],
  operator: [
    'artwork.view_public',
    'artwork.view_unpublished',
    'artwork.manage',
    'listing.manage',
    'order.view',
    'order.view_any',
    'collection.view',
    'mint_job.retry',
    'audit_log.view',
  ],
  auditor: [
    'artwork.view_public',
    'artwork.view_unpublished',
    'order.view',
    'order.view_any',
    'collection.view',
    'audit_log.view',
  ],
};

/**
 * 所有権の確認が必要な操作と、その免除条件。
 *
 * ロール判定だけで通すと、他人のIDを指定して閲覧できる脆弱性（IDOR）になる。
 * これらの操作では、対象リソースの所有者とアクターの一致を必ず確認する。
 *
 * `bypass` を持つ操作は、その広域権限を持つロールに限り所有権チェックを免除する。
 * 免除は**操作ごとに明示**する。「管理者だから何でも見てよい」という
 * 包括的な抜け道を作らないため。
 */
const OWNERSHIP_RULES: Readonly<Partial<Record<Action, { readonly bypass?: Action }>>> = {
  'order.view': { bypass: 'order.view_any' },
  'checkout.create': {},
  // 受取の実行は購入者本人のみ。運営でも代行できない（UD-804 が未決定のため）。
  'claim.accept': {},
  // 運営が受取状況を見るときは /admin/entitlements（order.view_any）を使う。
  'collection.view': {},
};

export type AuthorizationDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: DenyReason };

export type DenyReason =
  'unauthenticated' | 'inactive_account' | 'role_not_permitted' | 'not_owner';

function allow(): AuthorizationDecision {
  return { allowed: true };
}

function deny(reason: DenyReason): AuthorizationDecision {
  return { allowed: false, reason };
}

/**
 * アクターが対象リソースに対して操作を行えるかを判定する。
 *
 * 判定は 3 段階（AUTHORIZATION_DESIGN.md §2.2）:
 *  1. 認証状態
 *  2. ロールに対する操作の許可
 *  3. 所有権
 */
export function can(actor: Actor, action: Action, resource: Resource = {}): AuthorizationDecision {
  // 1. 認証・アカウント状態
  if (actor.role !== 'anonymous') {
    if (actor.accountId === null) {
      return deny('unauthenticated');
    }
    if (!actor.isActive) {
      return deny('inactive_account');
    }
  }

  // 2. ロール判定
  if (!ROLE_ACTIONS[actor.role].includes(action)) {
    return deny('role_not_permitted');
  }

  // 3. 所有権判定
  const ownershipRule = OWNERSHIP_RULES[action];
  if (ownershipRule !== undefined) {
    const bypass = ownershipRule.bypass;
    const hasBypass = bypass !== undefined && ROLE_ACTIONS[actor.role].includes(bypass);
    if (!hasBypass) {
      if (actor.accountId === null) {
        return deny('unauthenticated');
      }
      if (resource.ownerAccountId == null || resource.ownerAccountId !== actor.accountId) {
        return deny('not_owner');
      }
    }
  }

  return allow();
}

/** 判定を真偽値だけで使いたい箇所のための薄い糖衣。 */
export function isAllowed(actor: Actor, action: Action, resource: Resource = {}): boolean {
  return can(actor, action, resource).allowed;
}
