import { describe, expect, it } from 'vitest';
import {
  ACTIONS,
  ROLES,
  ANONYMOUS,
  can,
  canAtRoleLevel,
  requiresOwnership,
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
  return { role, accountId: SELF, isActive: true, isOwner: false, ...overrides };
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
  // 会員なら誰でも「自分の作品」を出せる（`UD-806`、暫定）。
  // ⚠️ auditor は読み取り専用なので、自分名義でも出品させない。
  'artwork.create_own': { anonymous: false, buyer: true, operator: true, auditor: false },
  'artwork.manage_own': { anonymous: false, buyer: true, operator: true, auditor: false },
  'listing.manage_own': { anonymous: false, buyer: true, operator: true, auditor: false },
  'order.create': { anonymous: false, buyer: true, operator: false, auditor: false },
  'order.view': { anonymous: false, buyer: true, operator: true, auditor: true },
  'order.view_any': { anonymous: false, buyer: false, operator: true, auditor: true },
  // 問い合わせ対応（`UD-121`）。⚠️ auditor には渡していない。
  // 一覧を見ることと、人に紐づけて注文の有無を答えられることは別の力。
  'order.lookup_buyer': { anonymous: false, buyer: false, operator: true, auditor: false },
  // 返金・精算の設定（`UD-104` / `UD-119`）。
  // ⚠️ 見るのは auditor にも開く。返金の条件を確かめられないと監査にならない。
  //    変えるのはオーナーだけ（`OWNER_ONLY_ACTIONS` が追加で縛る）。
  'settlement.view': { anonymous: false, buyer: false, operator: true, auditor: true },
  // ⚠️ この表は「オーナーの印が無い人」の判定。オーナー限定なので
  //    operator でも拒否になる（下の「オーナーの印」で別に確かめる）。
  'settlement.manage': { anonymous: false, buyer: false, operator: false, auditor: false },
  'order.note': { anonymous: false, buyer: false, operator: true, auditor: false },
  /*
    ⚠️ **オーナーの印を要らない。** 問い合わせ対応の日常業務で、返金を
       止めると「返してもらえない」時間が延びる。乗っ取られたときの被害も
       `payment_credential.manage`（これからの売上の振込先が変わる）とは
       違い、払った本人のカードへ戻るだけで攻撃者の利得にならない。
    ⚠️ **`auditor` には渡さない。** お金が動く操作である。
  */
  'order.refund': { anonymous: false, buyer: false, operator: true, auditor: false },
  'checkout.create': { anonymous: false, buyer: true, operator: false, auditor: false },
  'claim.inspect': { anonymous: false, buyer: true, operator: false, auditor: false },
  'claim.accept': { anonymous: false, buyer: true, operator: false, auditor: false },
  'claim.reissue': { anonymous: false, buyer: true, operator: false, auditor: false },
  'collection.view': { anonymous: false, buyer: true, operator: true, auditor: true },
  'mint_job.retry': { anonymous: false, buyer: false, operator: true, auditor: false },
  'audit_log.view': { anonymous: false, buyer: false, operator: true, auditor: true },
  // ⚠️ **人事はロールだけでは通らない**（`UD-803`）。
  //    この表は「オーナーの印が無い人」の判定なので、operator でも拒否になる。
  //    印を持つ場合は下の別の組で確かめる。
  'staff.view': { anonymous: false, buyer: false, operator: false, auditor: false },
  'staff.invite': { anonymous: false, buyer: false, operator: false, auditor: false },
  'staff.manage': { anonymous: false, buyer: false, operator: false, auditor: false },
  // --- 外部連携（指示書 §8）---
  'integration.view': { anonymous: false, buyer: false, operator: true, auditor: true },
  // ⚠️ 印が無い operator は通らない。印を持つ場合は下の別の組で確かめる。
  'integration.manage': { anonymous: false, buyer: false, operator: false, auditor: false },
  'integration.manage_secret': { anonymous: false, buyer: false, operator: false, auditor: false },
  // 再送は印を要らない。運営の日常業務。
  'wallet_delivery.retry': { anonymous: false, buyer: false, operator: true, auditor: false },
  // --- 法務文書 ---
  // ⚠️ 監査役も過去の版を見られる。「その時点でどう書いてあったか」を
  //    確かめるのは監査の仕事そのもの。
  'legal.view': { anonymous: false, buyer: false, operator: true, auditor: true },
  // 下書きは運営スタッフが書ける。
  'legal.edit': { anonymous: false, buyer: false, operator: true, auditor: false },
  // ⚠️ 印が無い operator は通らない。公開は取り消せない。
  'legal.publish': { anonymous: false, buyer: false, operator: false, auditor: false },
  // 同意は本人が行う。会員なら誰でも持つ。
  'legal.consent': { anonymous: false, buyer: true, operator: true, auditor: true },
  // --- 決済資格情報の世代（`UD-118`）---
  'payment_credential.view': { anonymous: false, buyer: false, operator: true, auditor: true },
  // ⚠️ 印が無い operator は通らない。入金先が変わる操作。
  'payment_credential.manage': { anonymous: false, buyer: false, operator: false, auditor: false },
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

  it('他人の作品は buyer には触らせない（Z-2 / UD-102 決定変更）', () => {
    // ⚠️ ロール判定だけで通すと、他人の作品IDを指定して書き換えられる。
    const decision = can(actor('buyer'), 'artwork.manage_own', { ownerAccountId: OTHER });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('expected deny');
    expect(decision.reason).toBe('not_owner');
  });

  it('他人の出品も buyer には触らせない', () => {
    expect(isAllowed(actor('buyer'), 'listing.manage_own', { ownerAccountId: OTHER })).toBe(false);
  });

  it('自分の作品なら buyer でも触れる', () => {
    expect(isAllowed(actor('buyer'), 'artwork.manage_own', { ownerAccountId: SELF })).toBe(true);
    expect(isAllowed(actor('buyer'), 'listing.manage_own', { ownerAccountId: SELF })).toBe(true);
  });

  it('運営は他人の作品も止められる（審査は無いが、下ろす経路はある）', () => {
    // 出品前の審査を行わない代わりに、問題のある出品を事後に停止する。
    expect(isAllowed(actor('operator'), 'artwork.manage_own', { ownerAccountId: OTHER })).toBe(
      true,
    );
    expect(isAllowed(actor('operator'), 'listing.manage_own', { ownerAccountId: OTHER })).toBe(
      true,
    );
  });

  it('作品の新規登録には所有権が要らない（まだ作品が無いため）', () => {
    expect(requiresOwnership('artwork.create_own')).toBe(false);
    expect(isAllowed(actor('buyer'), 'artwork.create_own', {})).toBe(true);
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

  it('受取URLの再発行を運営が代行できない', () => {
    // ⚠️ 再発行は旧 URL を失効させ、新しい受取口を作る操作。
    //    代行できるなら「運営が誰かの受取先を差し替えられる」ことになる。
    //    運営代行の可否は UD-1009 で未決定。決まるまで経路を作らない。
    expect(isAllowed(actor('operator'), 'claim.reissue', { ownerAccountId: OTHER })).toBe(false);
    expect(isAllowed(actor('operator'), 'claim.reissue', { ownerAccountId: SELF })).toBe(false);
  });

  it('受取URLを再発行できるのは購入者本人だけ', () => {
    expect(isAllowed(actor('buyer'), 'claim.reissue', { ownerAccountId: SELF })).toBe(true);
    expect(isAllowed(actor('buyer'), 'claim.reissue', { ownerAccountId: OTHER })).toBe(false);
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
      'claim.reissue',
      'mint_job.retry',
    ];
    for (const action of writeActions) {
      expect(isAllowed(actor('auditor'), action, { ownerAccountId: SELF })).toBe(false);
    }
  });
});

describe('ガードが使う役割段階の判定', () => {
  it('所有権が要る操作でも、対象なしで入口を通せる', () => {
    // ⚠️ ここを can() で判定すると、対象を知らないガードでは常に拒否になり、
    //    エンドポイントへ永久に到達できない。実際 claim.reissue で起きた。
    expect(canAtRoleLevel(actor('buyer'), 'claim.reissue').allowed).toBe(true);
    expect(canAtRoleLevel(actor('buyer'), 'claim.accept').allowed).toBe(true);
    expect(canAtRoleLevel(actor('buyer'), 'checkout.create').allowed).toBe(true);
  });

  it('ロールで許されていない操作は入口で止まる', () => {
    expect(canAtRoleLevel(actor('operator'), 'claim.reissue').allowed).toBe(false);
    expect(canAtRoleLevel(actor('anonymous'), 'claim.reissue').allowed).toBe(false);
  });

  it('停止中のアカウントは入口で止まる', () => {
    const suspended = { role: 'buyer' as const, accountId: SELF, isActive: false, isOwner: false };
    expect(canAtRoleLevel(suspended, 'claim.reissue').allowed).toBe(false);
  });

  it('所有権が要る操作を宣言できる', () => {
    // ハンドラ側が「対象付きで呼び直す義務」を機械的に確かめられるようにする。
    expect(requiresOwnership('claim.reissue')).toBe(true);
    expect(requiresOwnership('claim.accept')).toBe(true);
    expect(requiresOwnership('artwork.manage')).toBe(false);
  });

  it('入口を通っても、対象付きの判定は別に要る', () => {
    // ⚠️ 入口を通ったことは「呼んでよい」までしか意味しない。
    expect(canAtRoleLevel(actor('buyer'), 'claim.reissue').allowed).toBe(true);
    expect(isAllowed(actor('buyer'), 'claim.reissue', { ownerAccountId: OTHER })).toBe(false);
  });
});

/**
 * 人事（`UD-803`）。
 *
 * ⚠️ **この組の主題は「印が無ければ通らない」こと。**
 * ここが緩むと、運営の 1 人が乗っ取られただけで全権限を配り直される。
 */
describe('オーナーの印', () => {
  const STAFF_ACTIONS = [
    'staff.view',
    'staff.invite',
    'staff.manage',
    'integration.manage',
    'integration.manage_secret',
    'legal.publish',
    'payment_credential.manage',
    // ⚠️ 返金と支払いの両方を動かす（`UD-104` / `UD-119`）。
    'settlement.manage',
  ] as const;

  for (const action of STAFF_ACTIONS) {
    it(`印を持つ operator は ${action} を行える`, () => {
      expect(isAllowed(actor('operator', { isOwner: true }), action)).toBe(true);
    });

    it(`印が無い operator は ${action} を行えない`, () => {
      expect(isAllowed(actor('operator'), action)).toBe(false);
    });

    it(`印を持っていても auditor は ${action} を行えない`, () => {
      // ⚠️ DB の CHECK でも縛っているが、判定側でも塞いでおく。
      //    片方だけの守りは、もう片方を直したときに黙って消える。
      expect(isAllowed(actor('auditor', { isOwner: true }), action)).toBe(false);
    });

    it(`印を持っていても buyer は ${action} を行えない`, () => {
      expect(isAllowed(actor('buyer', { isOwner: true }), action)).toBe(false);
    });

    it(`ガードの段階（対象を読む前）でも ${action} を止める`, () => {
      // ハンドラ側の書き漏れに頼らない。
      const decision = canAtRoleLevel(actor('operator'), action);
      expect(decision.allowed).toBe(false);
      if (decision.allowed) return;
      expect(decision.reason).toBe('not_site_owner');
    });
  }

  it('停止中のオーナーは人事を行えない', () => {
    expect(isAllowed(actor('operator', { isOwner: true, isActive: false }), 'staff.manage')).toBe(
      false,
    );
  });

  it('印は他の操作の可否を変えない', () => {
    // 人事の軸を足したことで、作品の権限まで広がっていないこと。
    expect(isAllowed(actor('auditor', { isOwner: true }), 'artwork.manage')).toBe(false);
    expect(isAllowed(actor('buyer', { isOwner: true }), 'artwork.manage')).toBe(false);
  });
});

/**
 * 外部連携（指示書 §8）。
 *
 * ⚠️ **閲覧と変更で線を引く場所が違う。** 状態は運営と閲覧者にも見せ、
 * 接続先と資格情報はオーナーだけにする。ここを一括で「運営なら可」に
 * すると、運営の 1 人が乗っ取られただけで送信先ごと差し替えられる。
 */
describe('外部連携の線引き', () => {
  it('印の無い operator も状態は見られる', () => {
    expect(isAllowed(actor('operator'), 'integration.view')).toBe(true);
  });

  it('auditor も状態は見られる', () => {
    expect(isAllowed(actor('auditor'), 'integration.view')).toBe(true);
  });

  it('auditor は再送できない', () => {
    expect(isAllowed(actor('auditor'), 'wallet_delivery.retry')).toBe(false);
  });

  it('印の無い operator は再送できる（日常業務のため）', () => {
    expect(isAllowed(actor('operator'), 'wallet_delivery.retry')).toBe(true);
  });

  it('buyer は状態すら見られない', () => {
    expect(isAllowed(actor('buyer'), 'integration.view')).toBe(false);
    expect(isAllowed(actor('buyer', { isOwner: true }), 'integration.manage')).toBe(false);
  });

  it('印を持っていても auditor は設定を変えられない', () => {
    expect(isAllowed(actor('auditor', { isOwner: true }), 'integration.manage')).toBe(false);
    expect(isAllowed(actor('auditor', { isOwner: true }), 'integration.manage_secret')).toBe(false);
  });
});
