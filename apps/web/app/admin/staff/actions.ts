'use server';

import { revalidatePath } from 'next/cache';
import {
  inviteStaff,
  revokeStaffInvitation,
  updateStaffMember,
  type AdminResult,
} from '../../../src/admin-client';
import { adminErrorMessage } from '../../../src/admin-copy';
import type { AdminActionState } from '../actions';

/**
 * スタッフの操作（`UD-803`）。
 *
 * ⚠️ **ここは受け渡しだけを行う。判定はすべて API 側。**
 * 「自分自身は変えられない」「最後のオーナーは降ろせない」といった規則を
 * 画面側にも書くと、2 か所に同じ規則ができて必ずずれる。
 */

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function fail<T>(result: AdminResult<T>): AdminActionState {
  return { error: result.ok ? undefined : adminErrorMessage(result.reason, result.code) };
}

function refresh(): void {
  revalidatePath('/admin/staff');
}

export async function inviteStaffAction(
  _previous: AdminActionState,
  form: FormData,
): Promise<AdminActionState> {
  const email = text(form, 'email');
  if (email === '') {
    return { error: 'メールアドレスを入力してください。' };
  }
  const role = text(form, 'role');
  if (role !== 'operator' && role !== 'auditor') {
    return { error: 'お任せすることを選んでください。' };
  }

  const result = await inviteStaff({ email, role });
  if (!result.ok) {
    return fail(result);
  }
  refresh();
  return {};
}

export async function revokeInvitationAction(
  _previous: AdminActionState,
  form: FormData,
): Promise<AdminActionState> {
  const result = await revokeStaffInvitation(text(form, 'invitationId'));
  if (!result.ok) {
    return fail(result);
  }
  refresh();
  return {};
}

/**
 * スタッフの権限を変える。
 *
 * ⚠️ **何を変えるかを 1 つの欄で受け取る。** 役割・停止・オーナーを
 * 別々の経路にすると、画面が増えるわりに、どれを押したのか分かりにくくなる。
 */
export async function updateStaffAction(
  _previous: AdminActionState,
  form: FormData,
): Promise<AdminActionState> {
  const accountId = text(form, 'accountId');
  const change = text(form, 'change');

  const request =
    change === 'suspend'
      ? { status: 'suspended' as const }
      : change === 'resume'
        ? { status: 'active' as const }
        : change === 'make_operator'
          ? { role: 'operator' as const }
          : change === 'make_auditor'
            ? { role: 'auditor' as const }
            : change === 'make_owner'
              ? { isOwner: true }
              : change === 'remove'
                ? { role: 'buyer' as const, isOwner: false }
                : null;

  if (request === null) {
    return { error: 'この操作は行えません。' };
  }

  const result = await updateStaffMember(accountId, request);
  if (!result.ok) {
    return fail(result);
  }
  refresh();
  return {};
}
