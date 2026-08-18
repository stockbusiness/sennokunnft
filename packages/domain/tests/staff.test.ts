import { describe, expect, it } from 'vitest';
import {
  acceptInvitation,
  applyInvitationToMember,
  changeMembership,
  createInvitation,
  expireInvitation,
  isInvitationOpen,
  normalizeEmail,
  revokeInvitation,
  type StaffInvitation,
  type StaffMember,
} from '../src/index';

/**
 * 運営スタッフの招待と権限（`UD-803`）。
 *
 * ⚠️ **この試験の主題は「取れないこと」。**
 * ここは壊れると全部取られる場所なので、
 * 「招待できた」より「他人の招待を横取りできない」「締め出されない」を厚く見る。
 */

const NOW = new Date('2026-08-18T00:00:00.000Z');
const LATER = new Date('2026-08-26T00:00:00.000Z'); // 8 日後（期限は 7 日）

function invitation(overrides: Partial<StaffInvitation> = {}): StaffInvitation {
  return {
    id: 'inv-1',
    email: 'staff@example.com',
    role: 'operator',
    status: 'pending',
    invitedByAccountId: 'owner-1',
    acceptedByAccountId: null,
    expiresAt: new Date(NOW.getTime() + 7 * 86_400_000),
    acceptedAt: null,
    closedAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

function member(overrides: Partial<StaffMember> = {}): StaffMember {
  return {
    accountId: 'account-1',
    role: 'operator',
    status: 'active',
    isOwner: false,
    staffEmail: 'staff@example.com',
    ...overrides,
  };
}

describe('招待を作る', () => {
  it('宛先の大文字小文字と前後の空白をそろえる', () => {
    // そろえないと、同じ人へ二重に招待でき、片方を取り消しても入れてしまう。
    const result = createInvitation({
      id: 'inv-1',
      email: '  Staff@Example.COM ',
      role: 'operator',
      invitedByAccountId: 'owner-1',
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.email).toBe('staff@example.com');
  });

  it('7 日で期限が切れる', () => {
    const result = createInvitation({
      id: 'inv-1',
      email: 'a@example.com',
      role: 'auditor',
      invitedByAccountId: 'owner-1',
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.expiresAt.getTime() - NOW.getTime()).toBe(7 * 86_400_000);
  });

  it('buyer は招待で配れない', () => {
    // 招待はスタッフを増やす道具。役割を下げる操作を紛れ込ませない。
    const result = createInvitation({
      id: 'inv-1',
      email: 'a@example.com',
      role: 'buyer',
      invitedByAccountId: 'owner-1',
      now: NOW,
    });
    expect(result.ok).toBe(false);
  });

  it('宛先が空なら作れない', () => {
    const result = createInvitation({
      id: 'inv-1',
      email: '   ',
      role: 'operator',
      invitedByAccountId: 'owner-1',
      now: NOW,
    });
    expect(result.ok).toBe(false);
  });
});

describe('招待を受け取る', () => {
  it('宛先が一致すればスタッフになれる', () => {
    const result = acceptInvitation({
      invitation: invitation(),
      accountId: 'account-9',
      verifiedEmail: 'Staff@Example.com',
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.invitation.status).toBe('accepted');
    expect(result.value.invitation.acceptedByAccountId).toBe('account-9');
    expect(result.value.grantedRole).toBe('operator');
  });

  it('別の宛先の人は受け取れない', () => {
    // ⚠️ ここが通ると、他人宛の招待で権限を取れる。
    const result = acceptInvitation({
      invitation: invitation(),
      accountId: 'account-9',
      verifiedEmail: 'someone-else@example.com',
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('STAFF_INVITE_NOT_OPEN');
  });

  it('宛先の違いを「招待が無い」と同じ符号で返す', () => {
    // 分けると、どの宛先へ招待が出ているかを総当たりで探れる。
    const mismatch = acceptInvitation({
      invitation: invitation(),
      accountId: 'a',
      verifiedEmail: 'other@example.com',
      now: NOW,
    });
    const revoked = acceptInvitation({
      invitation: invitation({ status: 'revoked', closedAt: NOW }),
      accountId: 'a',
      verifiedEmail: 'staff@example.com',
      now: NOW,
    });
    expect(mismatch.ok).toBe(false);
    expect(revoked.ok).toBe(false);
    if (mismatch.ok || revoked.ok) return;
    expect(mismatch.error.code).toBe(revoked.error.code);
  });

  it('確認済みの宛先が空なら受け取れない', () => {
    // 招待側の宛先も空にはできないが、両方が空で一致してしまう事故を塞ぐ。
    const result = acceptInvitation({
      invitation: invitation({ email: '' }),
      accountId: 'a',
      verifiedEmail: '',
      now: NOW,
    });
    expect(result.ok).toBe(false);
  });

  it('期限を過ぎたら受け取れない', () => {
    const result = acceptInvitation({
      invitation: invitation(),
      accountId: 'a',
      verifiedEmail: 'staff@example.com',
      now: LATER,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('STAFF_INVITE_EXPIRED');
  });

  it('一度受け取った招待は二度使えない', () => {
    const result = acceptInvitation({
      invitation: invitation({
        status: 'accepted',
        acceptedByAccountId: 'account-1',
        acceptedAt: NOW,
      }),
      accountId: 'account-9',
      verifiedEmail: 'staff@example.com',
      now: NOW,
    });
    expect(result.ok).toBe(false);
  });

  it('取り消された招待は受け取れない', () => {
    const result = acceptInvitation({
      invitation: invitation({ status: 'revoked', closedAt: NOW }),
      accountId: 'a',
      verifiedEmail: 'staff@example.com',
      now: NOW,
    });
    expect(result.ok).toBe(false);
  });
});

describe('招待を閉じる', () => {
  it('pending の招待は取り消せる', () => {
    const result = revokeInvitation(invitation(), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('revoked');
    expect(result.value.closedAt).toEqual(NOW);
  });

  it('受諾済みの招待は取り消せない（権限の剥奪と混同させない）', () => {
    const result = revokeInvitation(
      invitation({ status: 'accepted', acceptedByAccountId: 'a', acceptedAt: NOW }),
      NOW,
    );
    expect(result.ok).toBe(false);
  });

  it('期限が来ていないものを期限切れにできない', () => {
    expect(expireInvitation(invitation(), NOW).ok).toBe(false);
    expect(expireInvitation(invitation(), LATER).ok).toBe(true);
  });

  it('期限を過ぎた pending は「開いている」と見なさない', () => {
    expect(isInvitationOpen(invitation(), NOW)).toBe(true);
    expect(isInvitationOpen(invitation(), LATER)).toBe(false);
  });
});

describe('スタッフの権限を変える', () => {
  it('自分自身は変えられない', () => {
    // 押し間違いで自分を締め出すのを防ぎ、「自分だけ上げる」経路も作らない。
    const result = changeMembership({
      actorAccountId: 'account-1',
      target: member({ accountId: 'account-1', isOwner: true }),
      isOwner: false,
      activeOwnerCount: 2,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('STAFF_SELF_CHANGE');
  });

  it('一般会員をここから引き上げられない（招待を通す）', () => {
    const result = changeMembership({
      actorAccountId: 'owner-1',
      target: member({ role: 'buyer', staffEmail: null }),
      role: 'operator',
      activeOwnerCount: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('STAFF_NOT_MEMBER');
  });

  it('閲覧のみの人をオーナーにできない', () => {
    const result = changeMembership({
      actorAccountId: 'owner-1',
      target: member({ role: 'auditor' }),
      isOwner: true,
      activeOwnerCount: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('STAFF_OWNER_MUST_BE_OPERATOR');
  });

  it('オーナーの役割を落とすと、オーナーの印も一緒に外さないと通らない', () => {
    const result = changeMembership({
      actorAccountId: 'owner-1',
      target: member({ isOwner: true }),
      role: 'auditor',
      activeOwnerCount: 2,
    });
    expect(result.ok).toBe(false);
  });

  it('最後のオーナーは降ろせない', () => {
    // 0 人になると、以後誰も権限を配れず、DB を直接触るしか復旧手段が無い。
    const result = changeMembership({
      actorAccountId: 'someone-else',
      target: member({ accountId: 'owner-1', isOwner: true }),
      isOwner: false,
      activeOwnerCount: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('STAFF_LAST_OWNER');
  });

  it('最後のオーナーは停止もできない', () => {
    const result = changeMembership({
      actorAccountId: 'someone-else',
      target: member({ accountId: 'owner-1', isOwner: true }),
      status: 'suspended',
      activeOwnerCount: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('STAFF_LAST_OWNER');
  });

  it('オーナーが 2 人いれば、片方を降ろせる', () => {
    const result = changeMembership({
      actorAccountId: 'owner-1',
      target: member({ accountId: 'owner-2', isOwner: true }),
      isOwner: false,
      activeOwnerCount: 2,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.isOwner).toBe(false);
    expect(result.value.role).toBe('operator');
  });

  it('オーナーは別の運営をオーナーにできる（引き継ぎのため）', () => {
    const result = changeMembership({
      actorAccountId: 'owner-1',
      target: member({ accountId: 'account-2' }),
      isOwner: true,
      activeOwnerCount: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.isOwner).toBe(true);
  });

  it('スタッフから外すと、連絡先も残らない', () => {
    const result = changeMembership({
      actorAccountId: 'owner-1',
      target: member({ accountId: 'account-2' }),
      role: 'buyer',
      activeOwnerCount: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.role).toBe('buyer');
    expect(result.value.staffEmail).toBeNull();
  });

  it('指定しなかった項目は変わらない', () => {
    const result = changeMembership({
      actorAccountId: 'owner-1',
      target: member({ accountId: 'account-2', role: 'auditor' }),
      status: 'suspended',
      activeOwnerCount: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.role).toBe('auditor');
    expect(result.value.status).toBe('suspended');
  });
});

describe('招待をアカウントへ適用する', () => {
  it('会員がスタッフになる', () => {
    const result = applyInvitationToMember(
      member({ role: 'buyer', staffEmail: null }),
      'auditor',
      'staff@example.com',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.role).toBe('auditor');
    expect(result.value.staffEmail).toBe('staff@example.com');
  });

  it('招待ではオーナーにならない（人事権は招待状で渡らない）', () => {
    const result = applyInvitationToMember(
      member({ role: 'buyer', staffEmail: null }),
      'operator',
      'staff@example.com',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.isOwner).toBe(false);
  });

  it('すでにスタッフの人の役割を、招待で下げない', () => {
    // 運営の人へ閲覧のみの招待を誤って送っても、リンクを開くだけで下がらない。
    const result = applyInvitationToMember(member({ role: 'operator' }), 'auditor', 'a@b.example');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('STAFF_ALREADY_MEMBER');
  });

  it('停止中の人は招待で復帰できない', () => {
    const result = applyInvitationToMember(
      member({ role: 'buyer', status: 'suspended', staffEmail: null }),
      'operator',
      'a@b.example',
    );
    expect(result.ok).toBe(false);
  });
});

describe('normalizeEmail', () => {
  it('形の検証はしない（実在するのに弾かれる宛先を作らない）', () => {
    expect(normalizeEmail(' A@B ')).toBe('a@b');
    expect(normalizeEmail('これはメールではない')).toBe('これはメールではない');
  });
});
