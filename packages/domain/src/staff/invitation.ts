import { err, ok, type Result } from '../shared/result';
import { domainError, type DomainError } from '../shared/errors';

/**
 * スタッフの招待（`UD-803` 決定 2026-08-18）。
 *
 * ⚠️ **招待リンクのトークンを持たない。**
 * 受諾は「その宛先でログインできたこと」だけで判定する。
 * トークンを配ると、転送・流出したリンクを拾った別人が権限を得られる。
 * 受信箱に届く経路そのものを本人確認に使い、鍵を増やさない。
 *
 * ⚠️ **招待で `buyer` を配らない。** 招待はスタッフを増やす道具で、
 * 一般会員はログインすれば勝手に作られる。ここに `buyer` を通すと
 * 「招待で役割を下げる」という別の操作が紛れ込む。
 */

/** 招待で配れる役割。**ここに `buyer` を足さない。** */
export const INVITABLE_ROLES = ['operator', 'auditor'] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

export type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

export interface StaffInvitation {
  readonly id: string;
  /** 招待した宛先。オーナーが入力した値をそのまま残す。 */
  readonly email: string;
  readonly role: InvitableRole;
  readonly status: InvitationStatus;
  readonly invitedByAccountId: string;
  readonly acceptedByAccountId: string | null;
  readonly expiresAt: Date;
  readonly acceptedAt: Date | null;
  readonly closedAt: Date | null;
  readonly createdAt: Date;
}

/**
 * 招待の有効期間。
 *
 * ⚠️ **無期限にしない。** 送ったことを忘れた招待が何か月も生き残り、
 * 退職者や誤送信の宛先が、あとから権限を取れる状態が続く。
 */
export const INVITATION_LIFETIME_DAYS = 7;

/**
 * メールアドレスを突き合わせるための形にそろえる。
 *
 * ⚠️ **大文字小文字を区別しない。** 理屈のうえでは局所部は区別されうるが、
 * 実務で区別する事業者はほぼ無く、区別すると「同じ人なのに別人」として
 * 二重に招待でき、片方を取り消しても、もう片方で入れてしまう。
 *
 * ⚠️ **ここで妥当性の検証をしない。** 「正しいメールアドレスの形」を
 * こちらで決めると、実在するのに弾かれる宛先が出る。届くかどうかは
 * 送ってみるまで分からない。ここは突き合わせの正規化だけを担う。
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface CreateInvitationInput {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  readonly invitedByAccountId: string;
  readonly now: Date;
}

export function createInvitation(
  input: CreateInvitationInput,
): Result<StaffInvitation, DomainError> {
  const email = normalizeEmail(input.email);
  if (email === '') {
    return err(domainError('STAFF_INVITE_INVALID', 'email is empty'));
  }
  if (!isInvitableRole(input.role)) {
    return err(domainError('STAFF_INVITE_INVALID', 'role is not invitable'));
  }

  return ok({
    id: input.id,
    email,
    role: input.role,
    status: 'pending',
    invitedByAccountId: input.invitedByAccountId,
    acceptedByAccountId: null,
    expiresAt: new Date(input.now.getTime() + INVITATION_LIFETIME_DAYS * 86_400_000),
    acceptedAt: null,
    closedAt: null,
    createdAt: input.now,
  });
}

export function isInvitableRole(role: string): role is InvitableRole {
  return (INVITABLE_ROLES as readonly string[]).includes(role);
}

/** 期限を過ぎているか。**状態が `pending` のままでも、過ぎていれば使えない。** */
export function isExpired(invitation: StaffInvitation, now: Date): boolean {
  return invitation.expiresAt.getTime() <= now.getTime();
}

/** いま受け取れる招待か。画面の表示にも使う。 */
export function isOpen(invitation: StaffInvitation, now: Date): boolean {
  return invitation.status === 'pending' && !isExpired(invitation, now);
}

export interface AcceptInvitationInput {
  readonly invitation: StaffInvitation;
  /** ログインした人のアカウントID。 */
  readonly accountId: string;
  /** ログインした人の、認証プロバイダが確認済みのメールアドレス。 */
  readonly verifiedEmail: string;
  readonly now: Date;
}

export interface AcceptedInvitation {
  readonly invitation: StaffInvitation;
  /** 受諾によってアカウントへ入る値。 */
  readonly grantedRole: InvitableRole;
  readonly staffEmail: string;
}

/**
 * 招待を受け取る。
 *
 * ⚠️ **宛先の一致を必ず確かめる。** 招待を「id で受ける」形にすると、
 * 他人宛の招待IDを指定して権限を取れる。受けられるのは、
 * **その宛先でログインできた人だけ**。
 *
 * ⚠️ **`verifiedEmail` は認証プロバイダが確認した値だけを渡すこと。**
 * 利用者が自由に書き換えられる欄を渡すと、宛先を騙って権限を取れる。
 * 本システムではマジックリンクを開けた事実がその確認にあたる。
 */
export function acceptInvitation(
  input: AcceptInvitationInput,
): Result<AcceptedInvitation, DomainError> {
  const { invitation, now } = input;

  if (invitation.status === 'accepted') {
    return err(domainError('STAFF_INVITE_NOT_OPEN', 'already accepted'));
  }
  if (invitation.status === 'revoked' || invitation.status === 'expired') {
    return err(domainError('STAFF_INVITE_NOT_OPEN', 'closed'));
  }
  if (isExpired(invitation, now)) {
    return err(domainError('STAFF_INVITE_EXPIRED', 'past expiry'));
  }

  const verified = normalizeEmail(input.verifiedEmail);
  if (verified === '' || verified !== invitation.email) {
    // ⚠️ 「宛先が違う」と「招待が無い」を呼び出し側で区別して見せない。
    //    どの宛先に招待が出ているかを、総当たりで探れてしまう。
    return err(domainError('STAFF_INVITE_NOT_OPEN', 'recipient mismatch'));
  }

  return ok({
    invitation: {
      ...invitation,
      status: 'accepted',
      acceptedByAccountId: input.accountId,
      acceptedAt: now,
    },
    grantedRole: invitation.role,
    staffEmail: invitation.email,
  });
}

/** 招待を取り消す。届いたリンクを開かれる前に止める操作。 */
export function revokeInvitation(
  invitation: StaffInvitation,
  now: Date,
): Result<StaffInvitation, DomainError> {
  if (invitation.status !== 'pending') {
    // 受諾済みを「取り消し」で戻せると、権限の剥奪と混同される。
    // すでにスタッフになった人を外すのは、役割の変更で行う。
    return err(domainError('STAFF_INVITE_NOT_OPEN', 'not pending'));
  }
  return ok({ ...invitation, status: 'revoked', closedAt: now });
}

/** 期限切れとして閉じる。取り消しとは区別する（誰も操作していないため）。 */
export function expireInvitation(
  invitation: StaffInvitation,
  now: Date,
): Result<StaffInvitation, DomainError> {
  if (invitation.status !== 'pending') {
    return err(domainError('STAFF_INVITE_NOT_OPEN', 'not pending'));
  }
  if (!isExpired(invitation, now)) {
    return err(domainError('STAFF_INVITE_NOT_OPEN', 'not yet expired'));
  }
  return ok({ ...invitation, status: 'expired', closedAt: now });
}
