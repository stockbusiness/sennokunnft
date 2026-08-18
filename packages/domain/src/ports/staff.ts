import type { InvitableRole, StaffInvitation } from '../staff/invitation';
import type { StaffMember } from '../staff/membership';

/**
 * 運営スタッフの保管庫（`UD-803`）。
 *
 * ⚠️ **数えることと書くことを分けない。** 「オーナーが何人いるか」を
 * 読んでから別の呼び出しで書くと、2 人のオーナーが同時に互いを降ろして
 * 0 人になれる。**同じトランザクションで**行う口をここに置く。
 */
export interface StaffMemberRepository {
  /** スタッフだけを返す。**一般会員は含めない。** */
  listStaff(): Promise<readonly StaffMember[]>;
  findById(accountId: string): Promise<StaffMember | null>;
  /**
   * 連絡先からスタッフを引く。**すでにスタッフの人を招待させない**ため。
   *
   * ⚠️ 大文字小文字を区別しないこと。区別すると、同じ人が別人として通る。
   */
  findByStaffEmail(email: string): Promise<StaffMember | null>;
  /**
   * 有効なオーナーの人数を数え、その数を前提にした更新を 1 つのトランザクションで書く。
   *
   * `decide` が `null` を返したら何も書かない。
   * ⚠️ 実装は対象行と、有効なオーナーの行をロックすること。
   */
  updateWithOwnerCount(
    accountId: string,
    decide: (
      member: StaffMember,
      activeOwnerCount: number,
    ) => StaffMember | null | Promise<StaffMember | null>,
  ): Promise<StaffMember>;
}

export interface StaffInvitationRepository {
  list(): Promise<readonly StaffInvitation[]>;
  findById(id: string): Promise<StaffInvitation | null>;
  /** いま生きている（`pending` かつ期限内の）招待を宛先で引く。 */
  findOpenByEmail(email: string, now: Date): Promise<StaffInvitation | null>;
  /**
   * 招待を作る。同じ宛先に生きた招待があれば `null` を返す。
   *
   * ⚠️ 期限切れのまま `pending` で残っている行は、ここで `expired` へ閉じてから作る。
   * 閉じないと部分UNIQUEに阻まれ、二度と同じ宛先へ招待できなくなる。
   */
  create(invitation: StaffInvitation, now: Date): Promise<StaffInvitation | null>;
  update(invitation: StaffInvitation): Promise<StaffInvitation>;
  /**
   * 招待の受諾とアカウントの更新を **1 トランザクションで**書く。
   *
   * ⚠️ 分けて書くと、途中で落ちたときに
   * 「招待は使用済みなのに権限が付いていない」人が生まれ、
   * 同じ宛先へ二度と招待できないまま復旧手段が無くなる。
   */
  acceptWithMember(
    invitation: StaffInvitation,
    member: StaffMember,
  ): Promise<{ invitation: StaffInvitation; member: StaffMember }>;
}

export type { InvitableRole };
