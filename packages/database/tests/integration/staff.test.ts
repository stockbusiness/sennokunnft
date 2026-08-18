import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../../generated/client';
import {
  PrismaStaffInvitationRepository,
  PrismaStaffMemberRepository,
} from '../../src/repositories/staff.repository';
import {
  createTestClient,
  integrationTestsAvailable,
  resetDatabase,
  violatesConstraint,
} from '../helpers/database';

/**
 * 運営スタッフの招待と権限を、実 PostgreSQL に対して確かめる（`UD-803`）。
 *
 * ⚠️ **ここを Fake で済ませない。** 確かめたいのは
 * 「同じ宛先に生きた招待を 2 通作れない」「オーナーが 0 人にならない」で、
 * それを保証しているのは部分UNIQUEと行ロック。メモリ実装では意味がない。
 */
const enabled = integrationTestsAvailable();
const suite = enabled ? describe : describe.skip;

let prisma: PrismaClient;
let members: PrismaStaffMemberRepository;
let invitations: PrismaStaffInvitationRepository;

const NOW = new Date('2026-08-18T00:00:00.000Z');
const LATER = new Date('2026-08-26T00:00:00.000Z');

beforeAll(async () => {
  if (!enabled) return;
  prisma = createTestClient();
  await prisma.$connect();
  members = new PrismaStaffMemberRepository(prisma);
  invitations = new PrismaStaffInvitationRepository(prisma);
});

afterAll(async () => {
  if (!enabled) return;
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!enabled) return;
  await resetDatabase(prisma);
});

async function seedAccount(
  options: {
    role?: 'buyer' | 'operator' | 'auditor';
    isOwner?: boolean;
    status?: 'active' | 'suspended';
    staffEmail?: string;
  } = {},
): Promise<string> {
  const id = randomUUID();
  await prisma.account.create({
    data: {
      id,
      authProvider: 'fake',
      authSubject: id,
      role: options.role ?? 'operator',
      status: options.status ?? 'active',
      isOwner: options.isOwner ?? false,
      staffEmail: options.staffEmail ?? null,
    },
  });
  return id;
}

function draft(
  email: string,
  invitedByAccountId: string,
  overrides: Partial<{ expiresAt: Date; role: 'operator' | 'auditor' }> = {},
) {
  return {
    id: randomUUID(),
    email,
    role: overrides.role ?? ('operator' as const),
    status: 'pending' as const,
    invitedByAccountId,
    acceptedByAccountId: null,
    expiresAt: overrides.expiresAt ?? new Date(NOW.getTime() + 7 * 86_400_000),
    acceptedAt: null,
    closedAt: null,
    createdAt: NOW,
  };
}

suite('アカウントの制約', () => {
  it('オーナーは operator でなければ保存できない', async () => {
    // 閲覧のみの人が人事を触れるのはおかしい。
    await expect(seedAccount({ role: 'auditor', isOwner: true })).rejects.toSatisfy((error) =>
      violatesConstraint(error, 'accounts_owner_is_operator'),
    );
  });

  it('一般会員に連絡先は入らない', async () => {
    // ⚠️ 購入者のメールを平文で持たない方針（`UD-503`）を、DB でも縛る。
    await expect(seedAccount({ role: 'buyer', staffEmail: 'buyer@example.com' })).rejects.toSatisfy(
      (error) => violatesConstraint(error, 'accounts_staff_email_only_for_staff'),
    );
  });

  it('同じ連絡先を 2 人のスタッフに割り当てられない', async () => {
    await seedAccount({ staffEmail: 'same@example.com' });
    // 大文字小文字を区別しないこと。区別すると同じ人を二重に登録できる。
    // ⚠️ 式インデックスなので、Prisma は名前ではなく `lower(staff_email)` を返す。
    await expect(seedAccount({ staffEmail: 'SAME@Example.com' })).rejects.toSatisfy((error) =>
      violatesConstraint(error, 'lower(staff_email)'),
    );
  });
});

suite('招待の制約', () => {
  it('同じ宛先に生きた招待は 1 通だけ', async () => {
    const owner = await seedAccount({ isOwner: true });
    const first = await invitations.create(draft('dup@example.com', owner), NOW);
    expect(first).not.toBeNull();

    // ⚠️ 2 通目が作れると、片方を取り消してももう片方で入れる。
    const second = await invitations.create(draft('DUP@Example.com', owner), NOW);
    expect(second).toBeNull();
  });

  it('期限切れの招待は閉じてから作り直せる', async () => {
    // ⚠️ ここが通らないと、期限切れのたびに同じ宛先へ二度と招待できなくなる。
    const owner = await seedAccount({ isOwner: true });
    const stale = draft('again@example.com', owner, {
      expiresAt: new Date(NOW.getTime() - 1000),
    });
    await invitations.create(stale, NOW);

    const fresh = await invitations.create(draft('again@example.com', owner), NOW);
    expect(fresh).not.toBeNull();

    const closed = await prisma.staffInvitation.findUniqueOrThrow({ where: { id: stale.id } });
    expect(closed.status).toBe('expired');
    expect(closed.closedAt).not.toBeNull();
  });

  it('buyer を配る招待は保存できない', async () => {
    const owner = await seedAccount({ isOwner: true });
    await expect(
      prisma.staffInvitation.create({
        data: {
          email: 'x@example.com',
          role: 'buyer',
          invitedByAccountId: owner,
          expiresAt: LATER,
        },
      }),
    ).rejects.toSatisfy((error) => violatesConstraint(error, 'staff_invitations_role_is_staff'));
  });

  it('受諾済みなのに誰が受けたか分からない行は保存できない', async () => {
    const owner = await seedAccount({ isOwner: true });
    await expect(
      prisma.staffInvitation.create({
        data: {
          email: 'y@example.com',
          role: 'operator',
          status: 'accepted',
          invitedByAccountId: owner,
          expiresAt: LATER,
        },
      }),
    ).rejects.toSatisfy((error) =>
      violatesConstraint(error, 'staff_invitations_accepted_is_complete'),
    );
  });

  it('期限内の pending だけを宛先で引ける', async () => {
    const owner = await seedAccount({ isOwner: true });
    await invitations.create(draft('open@example.com', owner), NOW);

    expect(await invitations.findOpenByEmail('OPEN@example.com', NOW)).not.toBeNull();
    // 期限を過ぎたら引けない。
    expect(await invitations.findOpenByEmail('open@example.com', LATER)).toBeNull();
  });
});

suite('スタッフの読み書き', () => {
  it('一覧に一般会員が混ざらない', async () => {
    const owner = await seedAccount({ isOwner: true });
    const viewer = await seedAccount({ role: 'auditor' });
    const buyer = await seedAccount({ role: 'buyer' });

    const list = await members.listStaff();
    const ids = list.map((item) => item.accountId);
    expect(ids).toContain(owner);
    expect(ids).toContain(viewer);
    expect(ids).not.toContain(buyer);
  });

  it('オーナーの印と連絡先が、生SQL経由でも正しく読める', async () => {
    // ⚠️ `SELECT *` の戻りは DB の列名のままで、`isOwner` は undefined になる。
    //    印が黙って外れるという最悪の壊れ方をするので、実DBで確かめる。
    const id = await seedAccount({ isOwner: true, staffEmail: 'owner@example.com' });
    const seen = await members.updateWithOwnerCount(id, (member) => {
      expect(member.isOwner).toBe(true);
      expect(member.staffEmail).toBe('owner@example.com');
      return null; // 何も書かない
    });
    expect(seen.isOwner).toBe(true);
  });

  it('有効なオーナーだけを数える', async () => {
    await seedAccount({ isOwner: true });
    await seedAccount({ isOwner: true, status: 'suspended' });
    const target = await seedAccount({ role: 'auditor' });

    let counted = -1;
    await members.updateWithOwnerCount(target, (_member, activeOwnerCount) => {
      counted = activeOwnerCount;
      return null;
    });
    expect(counted).toBe(1);
  });

  it('書いた内容が残る', async () => {
    const id = await seedAccount({ role: 'auditor', staffEmail: 'a@example.com' });
    const saved = await members.updateWithOwnerCount(id, (member) => ({
      ...member,
      role: 'buyer',
      staffEmail: null,
    }));
    expect(saved.role).toBe('buyer');

    const row = await prisma.account.findUniqueOrThrow({ where: { id } });
    expect(row.role).toBe('buyer');
    // スタッフでなくなったら連絡先も残らない（CHECK とも整合する）。
    expect(row.staffEmail).toBeNull();
  });

  it('先に始まった降格が終わるまで、次の降格は古い人数を見ない', async () => {
    // ⚠️ これがこの試験の主眼。数えてから別の呼び出しで書くと、
    //    どちらの判定も「まだ 2 人いる」を見て通り、オーナーが 0 人になる。
    //
    // ⚠️ **ただ 2 つ同時に投げるだけでは足りない。** それだと実際には
    //    順に流れてしまい、ロックを外しても試験が通る（実際に確かめた）。
    //    片方の取引を開けたまま、もう片方を始めさせて初めて競合になる。
    const first = await seedAccount({ isOwner: true });
    const second = await seedAccount({ isOwner: true });

    // 別の接続にする。同じ接続では、そもそも同時に走らない。
    const otherClient = createTestClient();
    await otherClient.$connect();
    const otherMembers = new PrismaStaffMemberRepository(otherClient);

    let insideFirst: () => void = () => undefined;
    const firstIsInside = new Promise<void>((resolve) => {
      insideFirst = resolve;
    });
    const counts: number[] = [];

    try {
      const a = members.updateWithOwnerCount(first, async (member, activeOwnerCount) => {
        counts.push(activeOwnerCount);
        insideFirst();
        // 取引を開けたまま、もう片方に始めさせる。
        await new Promise((resolve) => setTimeout(resolve, 300));
        return { ...member, isOwner: false };
      });

      await firstIsInside;
      const b = otherMembers.updateWithOwnerCount(second, (member, activeOwnerCount) => {
        counts.push(activeOwnerCount);
        // 自分が最後のオーナーなら降ろさない（ドメインと同じ判断）。
        return activeOwnerCount <= 1 ? null : { ...member, isOwner: false };
      });

      await Promise.all([a, b]);
    } finally {
      await otherClient.$disconnect();
    }

    // 後から始めたほうは、先が終わるまで待たされ、減った人数を見る。
    expect(counts).toEqual([2, 1]);

    const remaining = await prisma.account.count({
      where: { isOwner: true, status: 'active' },
    });
    expect(remaining).toBe(1);
  });

  it('受諾とアカウントの更新は、片方だけ残らない', async () => {
    const owner = await seedAccount({ isOwner: true });
    const invitee = await seedAccount({ role: 'buyer' });
    const invitation = await invitations.create(draft('join@example.com', owner), NOW);
    expect(invitation).not.toBeNull();
    if (invitation === null) return;

    await invitations.acceptWithMember(
      { ...invitation, status: 'accepted', acceptedByAccountId: invitee, acceptedAt: NOW },
      {
        accountId: invitee,
        role: 'operator',
        status: 'active',
        isOwner: false,
        staffEmail: 'join@example.com',
      },
    );

    const account = await prisma.account.findUniqueOrThrow({ where: { id: invitee } });
    expect(account.role).toBe('operator');
    expect(account.staffEmail).toBe('join@example.com');
    // ⚠️ 招待で人事権は渡らない。
    expect(account.isOwner).toBe(false);

    const row = await prisma.staffInvitation.findUniqueOrThrow({ where: { id: invitation.id } });
    expect(row.status).toBe('accepted');
    expect(row.acceptedByAccountId).toBe(invitee);
  });

  it('同じ招待が同時に 2 回開かれても、1 回しか通らない', async () => {
    const owner = await seedAccount({ isOwner: true });
    const one = await seedAccount({ role: 'buyer' });
    const two = await seedAccount({ role: 'buyer' });
    const invitation = await invitations.create(draft('race@example.com', owner), NOW);
    if (invitation === null) throw new Error('invitation was not created');

    const accept = (accountId: string) =>
      invitations.acceptWithMember(
        { ...invitation, status: 'accepted', acceptedByAccountId: accountId, acceptedAt: NOW },
        {
          accountId,
          role: 'operator',
          status: 'active',
          isOwner: false,
          staffEmail: `race+${accountId}@example.com`,
        },
      );

    const results = await Promise.allSettled([accept(one), accept(two)]);
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);

    const staff = await prisma.account.count({
      where: { id: { in: [one, two] }, role: 'operator' },
    });
    expect(staff).toBe(1);
  });
});
