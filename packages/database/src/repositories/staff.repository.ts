import type {
  InvitableRole,
  MemberRole,
  MemberStatus,
  StaffInvitation,
  StaffInvitationRepository,
  StaffMember,
  StaffMemberRepository,
} from '@sengoku/domain';
import type { PrismaClient } from '../../generated/client';
import type {
  Account as AccountRow,
  StaffInvitation as InvitationRow,
} from '../../generated/client';

function toMember(row: AccountRow): StaffMember {
  return {
    accountId: row.id,
    role: row.role as MemberRole,
    status: row.status as MemberStatus,
    isOwner: row.isOwner,
    staffEmail: row.staffEmail,
  };
}

function toInvitation(row: InvitationRow): StaffInvitation {
  return {
    id: row.id,
    email: row.email,
    role: row.role as InvitableRole,
    status: row.status as StaffInvitation['status'],
    invitedByAccountId: row.invitedByAccountId,
    acceptedByAccountId: row.acceptedByAccountId,
    expiresAt: row.expiresAt,
    acceptedAt: row.acceptedAt,
    closedAt: row.closedAt,
    createdAt: row.createdAt,
  };
}

/** 一意制約違反（PostgreSQL の 23505）か。 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
  );
}

export class PrismaStaffMemberRepository implements StaffMemberRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listStaff(): Promise<readonly StaffMember[]> {
    // ⚠️ **一般会員を混ぜない。** 混ぜると、運営の画面に全会員が並び、
    //    押し間違いで無関係の人の在籍を止められる。
    const rows = await this.prisma.account.findMany({
      where: { role: { in: ['operator', 'auditor'] } },
      orderBy: [{ isOwner: 'desc' }, { createdAt: 'asc' }],
    });
    return rows.map(toMember);
  }

  async findById(accountId: string): Promise<StaffMember | null> {
    const row = await this.prisma.account.findUnique({ where: { id: accountId } });
    return row === null ? null : toMember(row);
  }

  async findByStaffEmail(email: string): Promise<StaffMember | null> {
    const row = await this.prisma.account.findFirst({
      where: { staffEmail: { equals: email, mode: 'insensitive' } },
    });
    return row === null ? null : toMember(row);
  }

  /**
   * 有効なオーナーを数え、その数を前提にした更新を 1 トランザクションで書く。
   *
   * ⚠️ **数えてから別の呼び出しで書かない。** 2 人のオーナーが同時に
   * 互いを降ろすと、どちらの判定も「まだ 2 人いる」を見て通り、
   * **オーナーが 0 人**になる。以後、誰も権限を配れない。
   *
   * ⚠️ **行をロックしてから数える。** `SELECT ... FOR UPDATE` を
   * 有効なオーナーの行に掛けることで、同時に走る片方を待たせる。
   * ロックせずに数えると、上と同じことが起きる。
   */
  async updateWithOwnerCount(
    accountId: string,
    decide: (
      member: StaffMember,
      activeOwnerCount: number,
    ) => StaffMember | null | Promise<StaffMember | null>,
  ): Promise<StaffMember> {
    return this.prisma.$transaction(async (tx) => {
      // ⚠️ 対象より先にオーナーの行を取る。取る順番を毎回そろえないと、
      //    2 つの操作が互いのロックを待ち合ってデッドロックになる。
      const owners = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM accounts
        WHERE is_owner = true AND status = 'active'
        ORDER BY id
        FOR UPDATE
      `;
      // ⚠️ **`SELECT *` の結果をそのまま使わない。** 生SQLの戻りは
      //    DB の列名（`is_owner` / `staff_email`）のままで、Prisma の
      //    項目名には変換されない。`row.isOwner` は黙って `undefined` になり、
      //    「オーナーの印が必ず外れる」という最悪の壊れ方をする。
      //    ロックだけ生SQLで取り、値は Prisma 経由で読む。
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM accounts WHERE id = ${accountId}::uuid FOR UPDATE
      `;
      if (locked.length === 0) {
        throw new Error('staff member not found');
      }
      const row = await tx.account.findUniqueOrThrow({ where: { id: accountId } });

      const next = await decide(toMember(row), owners.length);
      if (next === null) {
        return toMember(row);
      }

      const saved = await tx.account.update({
        where: { id: accountId },
        data: {
          role: next.role,
          status: next.status,
          isOwner: next.isOwner,
          staffEmail: next.staffEmail,
        },
      });
      return toMember(saved);
    });
  }
}

export class PrismaStaffInvitationRepository implements StaffInvitationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async list(): Promise<readonly StaffInvitation[]> {
    const rows = await this.prisma.staffInvitation.findMany({ orderBy: { createdAt: 'desc' } });
    return rows.map(toInvitation);
  }

  async findById(id: string): Promise<StaffInvitation | null> {
    const row = await this.prisma.staffInvitation.findUnique({ where: { id } });
    return row === null ? null : toInvitation(row);
  }

  /**
   * いま生きている招待を宛先で引く。
   *
   * ⚠️ 生SQLで引かない。戻りが DB の列名のままになり、
   * `row.expiresAt` などが黙って `undefined` になる。
   * 大文字小文字を無視する比較は Prisma の `mode: 'insensitive'` で行う。
   */
  async findOpenByEmail(email: string, now: Date): Promise<StaffInvitation | null> {
    const row = await this.prisma.staffInvitation.findFirst({
      where: {
        status: 'pending',
        email: { equals: email, mode: 'insensitive' },
        expiresAt: { gt: now },
      },
    });
    return row === null ? null : toInvitation(row);
  }

  /**
   * 招待を作る。同じ宛先に生きた招待があれば `null`。
   *
   * ⚠️ **期限切れのまま `pending` で残った行を先に閉じる。**
   * 閉じないと部分UNIQUE（`staff_invitations_pending_email_key`）に阻まれ、
   * **同じ宛先へ二度と招待できなくなる**。招待が期限切れになるのは
   * ごく普通のことなので、ここを忘れると運用が詰まる。
   */
  async create(invitation: StaffInvitation, now: Date): Promise<StaffInvitation | null> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`
          UPDATE staff_invitations
          SET status = 'expired', closed_at = ${now}
          WHERE status = 'pending'
            AND lower(email) = lower(${invitation.email})
            AND expires_at <= ${now}
        `;
        const created = await tx.staffInvitation.create({
          data: {
            id: invitation.id,
            email: invitation.email,
            role: invitation.role,
            status: invitation.status,
            invitedByAccountId: invitation.invitedByAccountId,
            expiresAt: invitation.expiresAt,
            createdAt: invitation.createdAt,
          },
        });
        return toInvitation(created);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        // 生きた招待が既にある。**握りつぶして 2 通目を作らない。**
        return null;
      }
      throw error;
    }
  }

  async update(invitation: StaffInvitation): Promise<StaffInvitation> {
    const row = await this.prisma.staffInvitation.update({
      where: { id: invitation.id },
      data: {
        status: invitation.status,
        acceptedByAccountId: invitation.acceptedByAccountId,
        acceptedAt: invitation.acceptedAt,
        closedAt: invitation.closedAt,
      },
    });
    return toInvitation(row);
  }

  /**
   * 受諾とアカウントの更新を 1 トランザクションで書く。
   *
   * ⚠️ **分けて書かない。** 途中で落ちると
   * 「招待は使用済みなのに権限が付いていない」人が生まれ、
   * 同じ宛先へ二度と招待できないまま復旧手段が無くなる。
   *
   * ⚠️ **`WHERE status = 'pending'` を付ける。** 同じリンクが同時に
   * 2 回開かれたとき、更新件数で 1 回に絞る。
   */
  async acceptWithMember(
    invitation: StaffInvitation,
    member: StaffMember,
  ): Promise<{ invitation: StaffInvitation; member: StaffMember }> {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.staffInvitation.updateMany({
        where: { id: invitation.id, status: 'pending' },
        data: {
          status: 'accepted',
          acceptedByAccountId: invitation.acceptedByAccountId,
          acceptedAt: invitation.acceptedAt,
        },
      });
      if (claimed.count !== 1) {
        throw new Error('invitation was already closed');
      }

      const account = await tx.account.update({
        where: { id: member.accountId },
        data: {
          role: member.role,
          status: member.status,
          isOwner: member.isOwner,
          staffEmail: member.staffEmail,
        },
      });
      const row = await tx.staffInvitation.findUniqueOrThrow({ where: { id: invitation.id } });
      return { invitation: toInvitation(row), member: toMember(account) };
    });
  }
}
