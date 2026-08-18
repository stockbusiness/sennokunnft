import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  AcceptInvitationResponse,
  CreateStaffInvitationRequest,
  StaffInvitationView,
  StaffListResponse,
  StaffMemberView,
  UpdateStaffMemberRequest,
} from '@sengoku/contracts';
import type { Actor } from '@sengoku/auth';
import {
  acceptInvitation,
  applyInvitationToMember,
  changeMembership,
  createInvitation,
  isInvitationOpen,
  normalizeEmail,
  revokeInvitation,
  type ClockPort,
  type DomainError,
  type IdGeneratorPort,
  type AuditLogPort,
  type Result,
  type StaffInvitation,
  type StaffInvitationRepository,
  type StaffMember,
  type StaffMemberRepository,
} from '@sengoku/domain';
import { DomainErrorException } from '../common/domain-error.filter';

/**
 * 運営スタッフの招待と権限（`UD-803` 決定 2026-08-18）。
 *
 * ⚠️ **判断はドメインが持つ。** 「自分自身は変えられない」
 * 「最後のオーナーは降ろせない」といった規則をここへ書き足さない。
 * 書き足すと、規則が 2 か所に散り、片方だけ直したときに黙ってずれる。
 *
 * ⚠️ **オーナーかどうかの判定はガード（`staff.*`）が済ませている。**
 * ここでは「操作してよい人か」を再判定しない。ただし
 * **「誰が操作したか」は必ず監査ログへ残す**。人事は後から辿れないと困る。
 */
@Injectable()
export class StaffService {
  constructor(
    private readonly members: StaffMemberRepository,
    private readonly invitations: StaffInvitationRepository,
    private readonly ids: IdGeneratorPort,
    private readonly clock: ClockPort,
    private readonly audit: AuditLogPort,
  ) {}

  async list(actor: Actor): Promise<StaffListResponse> {
    const now = this.clock.now();
    const [members, invitations] = await Promise.all([
      this.members.listStaff(),
      this.invitations.list(),
    ]);
    return {
      viewerAccountId: requireActorId(actor),
      members: members.map(toMemberView),
      invitations: invitations.map((invitation) => toInvitationView(invitation, now)),
    };
  }

  /**
   * 招待を作る。
   *
   * ⚠️ **同じ宛先に生きた招待を 2 通作らせない。** 2 通あると、
   * 片方を取り消しても、もう片方でスタッフになれる。
   * 取り消したつもりが効いていない、が最も危ない形。
   */
  async invite(actor: Actor, request: CreateStaffInvitationRequest): Promise<StaffInvitationView> {
    const now = this.clock.now();
    const actorId = requireActorId(actor);

    // ⚠️ **すでにスタッフの人を招待させない。** 送っても、開いた時点で
    //    「もうスタッフです」と断られる死んだ招待になるだけで、
    //    一覧に「お返事待ち」として残り続け、送った側は待ち続ける。
    const existing = await this.members.findByStaffEmail(normalizeEmail(request.email));
    if (existing !== null && existing.role !== 'buyer') {
      throw new DomainErrorException('STAFF_ALREADY_MEMBER');
    }

    const draft = unwrapDomain(
      createInvitation({
        id: this.ids.generate(),
        email: request.email,
        role: request.role,
        invitedByAccountId: actorId,
        now,
      }),
    );

    const created = await this.invitations.create(draft, now);
    if (created === null) {
      throw new DomainErrorException('STAFF_INVITE_DUPLICATE');
    }

    await this.audit.record({
      actorAccountId: actorId,
      action: 'staff.invite',
      targetType: 'staff_invitation',
      targetId: created.id,
      // ⚠️ 宛先を残す。誰を招いたかが後から辿れないと、
      //    誤って招いたことにも、招かれた覚えのない人にも対処できない。
      summary: { email: created.email, role: created.role },
    });
    return toInvitationView(created, now);
  }

  /** 招待を取り消す。届いたリンクを開かれる前に止める操作。 */
  async revoke(actor: Actor, invitationId: string): Promise<StaffInvitationView> {
    const now = this.clock.now();
    const invitation = await this.invitations.findById(invitationId);
    if (invitation === null) {
      throw new NotFoundException();
    }
    const revoked = unwrapDomain(revokeInvitation(invitation, now));
    const saved = await this.invitations.update(revoked);

    await this.audit.record({
      actorAccountId: requireActorId(actor),
      action: 'staff.invite.revoke',
      targetType: 'staff_invitation',
      targetId: saved.id,
      summary: { email: saved.email },
    });
    return toInvitationView(saved, now);
  }

  /**
   * スタッフの役割・オーナー・在籍を変える。
   *
   * ⚠️ **数えることと書くことを分けない。** オーナーの人数を読んでから
   * 別の呼び出しで書くと、2 人のオーナーが同時に互いを降ろして
   * **0 人**になれる。判定は保管庫のトランザクションの中で行う。
   */
  async updateMember(
    actor: Actor,
    accountId: string,
    request: UpdateStaffMemberRequest,
  ): Promise<StaffMemberView> {
    const actorId = requireActorId(actor);
    const existing = await this.members.findById(accountId);
    if (existing === null) {
      throw new NotFoundException();
    }

    let failure: DomainError | null = null;
    const saved = await this.members.updateWithOwnerCount(accountId, (member, activeOwnerCount) => {
      const decision = changeMembership({
        actorAccountId: actorId,
        target: member,
        role: request.role,
        isOwner: request.isOwner,
        status: request.status,
        activeOwnerCount,
      });
      if (!decision.ok) {
        failure = decision.error;
        return null;
      }
      return decision.value;
    });

    if (failure !== null) {
      throw new DomainErrorException((failure as DomainError).code);
    }

    await this.audit.record({
      actorAccountId: actorId,
      action: 'staff.update',
      targetType: 'account',
      targetId: accountId,
      // ⚠️ 変更後の姿を残す。人事は「いつ誰がどうしたか」が問われる。
      summary: { role: saved.role, isOwner: saved.isOwner, status: saved.status },
    });
    return toMemberView(saved);
  }

  /**
   * ログインした本人が、自分宛の招待を引き取る。
   *
   * ⚠️ **待っている招待が無くても失敗にしない。** 普通のログインでも
   * 毎回呼ぶため、無ければ「何も起きなかった」を返すだけにする。
   *
   * ⚠️ **招待IDを受け取らない。** 受け取る形にすると、他人宛の招待IDを
   * 指定して権限を取れる。引けるのは**自分の確認済みアドレス**からだけ。
   */
  async acceptForSelf(
    actor: Actor,
    verifiedEmail: string | undefined,
  ): Promise<AcceptInvitationResponse> {
    const accountId = requireActorId(actor);
    if (verifiedEmail === undefined || verifiedEmail === '') {
      // 確認済みのアドレスが無い＝突き合わせようがない。静かに何もしない。
      return { accepted: false, role: null };
    }

    const now = this.clock.now();
    const invitation = await this.invitations.findOpenByEmail(normalizeEmail(verifiedEmail), now);
    if (invitation === null) {
      return { accepted: false, role: null };
    }

    const accepted = acceptInvitation({ invitation, accountId, verifiedEmail, now });
    if (!accepted.ok) {
      // ⚠️ 理由を返さない。どの宛先に招待が出ているかを探れてしまう。
      return { accepted: false, role: null };
    }

    const member = await this.members.findById(accountId);
    if (member === null) {
      return { accepted: false, role: null };
    }
    const applied = applyInvitationToMember(
      member,
      accepted.value.grantedRole,
      accepted.value.staffEmail,
    );
    if (!applied.ok) {
      return { accepted: false, role: null };
    }

    try {
      await this.invitations.acceptWithMember(accepted.value.invitation, applied.value);
    } catch {
      // 同じリンクが同時に 2 回開かれた。片方は何も起きなかったとして返す。
      return { accepted: false, role: null };
    }

    await this.audit.record({
      // ⚠️ 招いた人ではなく、受け取った本人を操作者として残す。
      actorAccountId: accountId,
      action: 'staff.invite.accept',
      targetType: 'staff_invitation',
      targetId: invitation.id,
      summary: { role: accepted.value.grantedRole },
    });
    return { accepted: true, role: accepted.value.grantedRole };
  }
}

function toMemberView(member: StaffMember): StaffMemberView {
  return {
    accountId: member.accountId,
    role: member.role,
    status: member.status,
    isOwner: member.isOwner,
    email: member.staffEmail,
  };
}

function toInvitationView(invitation: StaffInvitation, now: Date): StaffInvitationView {
  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    status: invitation.status,
    // 期限を過ぎた `pending` を「生きている」と見せない。
    isOpen: isInvitationOpen(invitation, now),
    expiresAt: invitation.expiresAt.toISOString(),
    createdAt: invitation.createdAt.toISOString(),
    acceptedAt: invitation.acceptedAt?.toISOString() ?? null,
  };
}

function unwrapDomain<T>(result: Result<T, DomainError>): T {
  if (!result.ok) {
    throw new DomainErrorException(result.error.code);
  }
  return result.value;
}

function requireActorId(actor: Actor): string {
  if (actor.accountId === null) {
    throw new ConflictException();
  }
  return actor.accountId;
}
