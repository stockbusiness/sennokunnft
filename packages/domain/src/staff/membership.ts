import { err, ok, type Result } from '../shared/result';
import { domainError, type DomainError } from '../shared/errors';

/**
 * 運営スタッフの在籍と権限（`UD-803` 決定 2026-08-18）。
 *
 * ⚠️ **役割は増やしていない。** 「何ができるか」は今までどおり 3 つ。
 * ここで扱うのは **「人に権限を配れるか」という別の軸**（`isOwner`）。
 *
 * ⚠️ **この画面から新しい人を作れない。** スタッフになる道は招待だけ。
 * 会員の一覧から誰でも昇格できる形にすると、
 * (1) 誰が誰かを見分けるために全会員の連絡先を運営へ見せることになり、
 * (2) 押し間違いで無関係の会員が運営になる。
 * 入口を招待の 1 本に絞ることが、そのまま守りになる。
 */

export type MemberRole = 'buyer' | 'operator' | 'auditor';
export type MemberStatus = 'active' | 'suspended';

export interface StaffMember {
  readonly accountId: string;
  readonly role: MemberRole;
  readonly status: MemberStatus;
  readonly isOwner: boolean;
  readonly staffEmail: string | null;
}

export interface ChangeMembershipInput {
  /** 操作している人（オーナー）。 */
  readonly actorAccountId: string;
  readonly target: StaffMember;
  readonly role?: MemberRole;
  readonly isOwner?: boolean;
  readonly status?: MemberStatus;
  /**
   * いま**有効な**オーナーの人数（対象を含む）。
   *
   * ⚠️ 呼び出し側は、この数と更新を**同じトランザクション**で扱うこと。
   * 別々に読むと、2 人のオーナーが同時に互いを降ろして 0 人になれる。
   */
  readonly activeOwnerCount: number;
}

/**
 * スタッフの役割・オーナー・在籍を変える。
 *
 * ⚠️ **自分自身は変えられない。** 押し間違いで自分を締め出すのを防ぐのと、
 * 「自分だけ上げる」経路を作らないため。オーナーを降りるときは、
 * 先にもう 1 人オーナーを立て、その人に降ろしてもらう。
 *
 * ⚠️ **最後のオーナーは失われない。** 0 人になると、以後**誰も**
 * 権限を配れなくなり、DB を直接触るしか復旧手段が無くなる。
 */
export function changeMembership(input: ChangeMembershipInput): Result<StaffMember, DomainError> {
  const { target } = input;

  if (input.actorAccountId === target.accountId) {
    return err(domainError('STAFF_SELF_CHANGE', 'actor is the target'));
  }

  // 招待を経ていない人（一般会員）をここから引き上げない。
  if (target.role === 'buyer') {
    return err(domainError('STAFF_NOT_MEMBER', 'target is not staff'));
  }

  const role = input.role ?? target.role;
  const isOwner = input.isOwner ?? target.isOwner;
  const status = input.status ?? target.status;

  // ⚠️ DB の CHECK（accounts_owner_is_operator）と同じ規則をここにも置く。
  //    閲覧のみの人が人事を触れるのはおかしい。
  if (isOwner && role !== 'operator') {
    return err(domainError('STAFF_OWNER_MUST_BE_OPERATOR', 'owner must be operator'));
  }

  // ⚠️ 有効なオーナーが減る向きの変更を、最後の 1 人に対して許さない。
  //    自分自身は上で弾いているため、通常はここへ来ない。
  //    それでも置くのは、**不変条件を明示して試験できるようにする**ため。
  const losesOwnership = target.isOwner && (!isOwner || status !== 'active');
  if (losesOwnership && input.activeOwnerCount <= 1) {
    return err(domainError('STAFF_LAST_OWNER', 'would leave no active owner'));
  }

  return ok({
    accountId: target.accountId,
    role,
    isOwner,
    status,
    // ⚠️ スタッフでなくなったら連絡先も残さない。
    //    DB の CHECK（accounts_staff_email_only_for_staff）と揃える。
    //    「もう働いていない人の連絡先が残り続ける」を作らない。
    staffEmail: role === 'buyer' ? null : target.staffEmail,
  });
}

/**
 * 招待を受け取った人をスタッフにする。
 *
 * ⚠️ **すでにスタッフの人の役割を、招待で下げない。**
 * 運営の人へ閲覧のみの招待を送ってしまったときに、
 * リンクを開いただけで権限が下がるのは事故になる。
 * 上がる向き（会員→スタッフ）だけを通す。
 */
export function applyInvitationToMember(
  member: StaffMember,
  grantedRole: 'operator' | 'auditor',
  staffEmail: string,
): Result<StaffMember, DomainError> {
  if (member.status !== 'active') {
    // 停止中の人が招待で復帰できると、停止の意味が無くなる。
    return err(domainError('STAFF_INVITE_NOT_OPEN', 'account is suspended'));
  }
  if (member.role !== 'buyer') {
    return err(domainError('STAFF_ALREADY_MEMBER', 'already staff'));
  }

  return ok({
    accountId: member.accountId,
    role: grantedRole,
    // ⚠️ 招待でオーナーにはしない。人事権は招待状では渡らない。
    isOwner: false,
    status: 'active',
    staffEmail,
  });
}
