import { z } from '@sengoku/validation';

/**
 * 運営スタッフの招待と権限（`UD-803` 決定 2026-08-18）。
 *
 * ⚠️ **ここに出るメールアドレスは、オーナーが自分で入力したスタッフの
 * 業務用アドレスだけ。** 購入者のアドレスは平文で保持しない（`UD-503`）。
 */

/** 招待で配れる役割。**`buyer` を足さない。** */
export const INVITABLE_ROLE_VALUES = ['operator', 'auditor'] as const;
export const MEMBER_ROLE_VALUES = ['buyer', 'operator', 'auditor'] as const;
export const MEMBER_STATUS_VALUES = ['active', 'suspended'] as const;
export const INVITATION_STATUS_VALUES = ['pending', 'accepted', 'revoked', 'expired'] as const;

export const staffMemberSchema = z.object({
  accountId: z.string(),
  role: z.enum(MEMBER_ROLE_VALUES),
  status: z.enum(MEMBER_STATUS_VALUES),
  /** 人に権限を配れるか。役割とは別の軸。 */
  isOwner: z.boolean(),
  email: z.string().nullable(),
});
export type StaffMemberView = z.infer<typeof staffMemberSchema>;

export const staffInvitationSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: z.enum(INVITABLE_ROLE_VALUES),
  status: z.enum(INVITATION_STATUS_VALUES),
  /**
   * いま受け取れる状態か。
   * ⚠️ 画面が `status === 'pending'` だけで判断しないための項目。
   * 期限を過ぎた `pending` は、まだ生きているように見えてしまう。
   */
  isOpen: z.boolean(),
  expiresAt: z.string(),
  createdAt: z.string(),
  acceptedAt: z.string().nullable(),
});
export type StaffInvitationView = z.infer<typeof staffInvitationSchema>;

export const staffListResponseSchema = z.object({
  /**
   * いま見ている人のアカウントID。
   *
   * ⚠️ **画面が「自分の行」を見分けるために要る。** 自分の行に操作を出すと、
   * 押しても必ず断られるボタンが並ぶ。
   * ⚠️ これは表示の都合であって、保護ではない。判定は API 側にある。
   */
  viewerAccountId: z.string(),
  members: z.array(staffMemberSchema),
  invitations: z.array(staffInvitationSchema),
});
export type StaffListResponse = z.infer<typeof staffListResponseSchema>;

export const createStaffInvitationRequestSchema = z.object({
  /**
   * 招待の宛先。
   *
   * ⚠️ **形の検証をしない。** 「正しいメールアドレスの形」をこちらで
   * 決めると、実在するのに弾かれる宛先が出る。長さだけ縛る。
   */
  email: z.string().trim().min(1).max(320),
  role: z.enum(INVITABLE_ROLE_VALUES),
});
export type CreateStaffInvitationRequest = z.infer<typeof createStaffInvitationRequestSchema>;

/**
 * スタッフの権限を変える。
 *
 * ⚠️ **`accountId` を本文で受け取らない。** 経路に含める。
 * 本文とURLで別のIDを送れると、どちらを見ているのか読み手に分からなくなる。
 */
export const updateStaffMemberRequestSchema = z
  .object({
    role: z.enum(MEMBER_ROLE_VALUES).optional(),
    isOwner: z.boolean().optional(),
    status: z.enum(MEMBER_STATUS_VALUES).optional(),
  })
  .refine(
    (value) =>
      value.role !== undefined || value.isOwner !== undefined || value.status !== undefined,
    { message: 'at least one field is required' },
  );
export type UpdateStaffMemberRequest = z.infer<typeof updateStaffMemberRequestSchema>;

/**
 * ログイン直後に呼ぶ、招待の引き取り。
 *
 * ⚠️ **待っている招待が無くても失敗にしない。** 普通のログインでも
 * 毎回呼ぶため、無ければ `accepted: false` を返すだけにする。
 * 失敗にすると、画面側が「エラー」を出す口実を持ってしまう。
 */
export const acceptInvitationResponseSchema = z.object({
  accepted: z.boolean(),
  role: z.enum(INVITABLE_ROLE_VALUES).nullable(),
});
export type AcceptInvitationResponse = z.infer<typeof acceptInvitationResponseSchema>;
