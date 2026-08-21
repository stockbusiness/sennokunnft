'use server';

import { revalidatePath } from 'next/cache';
import {
  addCustomerNote,
  fetchCustomerEmail,
  openEmailChange,
  settleEmailChange,
  verifyEmailChangeIdentity,
} from '../../../src/admin-client';
import { adminErrorMessage } from '../../../src/admin-copy';
import type { AdminActionState } from '../actions';

/**
 * 顧客サポートの操作（P1-1）。
 *
 * ⚠️ **ここに付け替えの操作を足さない。** 注文・受取権・ウォレットの
 * 持ち主を人が変えられる操作は、API にもこの画面にも存在しない。
 * 本人確認をしていない付け替えは、他人の持ち物を渡すことと同じである。
 *
 * ⚠️ **判定を書かない。** 「本人確認が済んでいるか」も「決着していないか」も
 * API 側が決める。画面にも書くと、2 か所で必ずずれる。
 */

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function optionalText(form: FormData, name: string): string | null {
  const value = text(form, name);
  return value === '' ? null : value;
}

export async function addNoteAction(
  _previous: AdminActionState,
  form: FormData,
): Promise<AdminActionState> {
  const accountId = text(form, 'accountId');
  const body = text(form, 'body');
  if (body === '') {
    return { error: '申し送りの内容をご記入ください。' };
  }

  const result = await addCustomerNote(accountId, body);
  if (!result.ok) {
    return { error: adminErrorMessage(result.reason, result.code) };
  }

  revalidatePath(`/admin/customers/${accountId}`);
  return {
    notice: '申し送りを残しました。',
    // ⚠️ 消せないことを、押したあとにも伝える。
    noticeHint: '申し送りは消せません。訂正は新しく書き足してください。',
  };
}

/**
 * ご連絡先の変更を申し出として受ける。
 *
 * ⚠️ **この操作でアドレスは変わらない。** 変えるのは認証基盤側で人が行う。
 * 押した運営が「変わったはず」と思って応対しないよう、結果にも書く。
 */
export async function openEmailChangeAction(
  _previous: AdminActionState,
  form: FormData,
): Promise<AdminActionState> {
  const accountId = text(form, 'accountId');
  const newEmail = text(form, 'newEmail');

  const result = await openEmailChange(accountId, newEmail);
  if (!result.ok) {
    return { error: adminErrorMessage(result.reason, result.code) };
  }

  revalidatePath(`/admin/customers/${accountId}`);
  return {
    notice: 'お申し出を記録しました。',
    noticeHint:
      'まだご連絡先は変わっていません。本人確認を記録したうえで、認証基盤側で変更してください。',
  };
}

/**
 * 本人確認を記録する。
 *
 * ⚠️ **「誰が」が残る。** 確認したことにする圧力は忙しい日にかかる。
 * 名前が残ると分かっていれば、飛ばしにくくなる。
 */
export async function verifyIdentityAction(
  _previous: AdminActionState,
  form: FormData,
): Promise<AdminActionState> {
  const accountId = text(form, 'accountId');
  const id = text(form, 'requestId');
  const method = text(form, 'method');

  const result = await verifyEmailChangeIdentity(id, method, optionalText(form, 'note'));
  if (!result.ok) {
    return { error: adminErrorMessage(result.reason, result.code) };
  }

  revalidatePath(`/admin/customers/${accountId}`);
  return {
    notice: '本人確認を記録しました。',
    noticeHint:
      'まだご連絡先は変わっていません。認証基盤側で変更してから「変更済み」にしてください。',
  };
}

/** 決着させる。⚠️ **本人確認を飛ばして「済」にはできない**（API が断る）。 */
export async function settleEmailChangeAction(
  _previous: AdminActionState,
  form: FormData,
): Promise<AdminActionState> {
  const accountId = text(form, 'accountId');
  const id = text(form, 'requestId');
  const status = text(form, 'status') === 'completed' ? 'completed' : 'rejected';
  const note = optionalText(form, 'note');

  if (status === 'rejected' && note === null) {
    return { error: '見送る理由をご記入ください。' };
  }

  const result = await settleEmailChange(id, status, note);
  if (!result.ok) {
    return { error: adminErrorMessage(result.reason, result.code) };
  }

  revalidatePath(`/admin/customers/${accountId}`);
  return {
    notice: status === 'completed' ? '変更済みとして記録しました。' : '見送りとして記録しました。',
  };
}

/**
 * ご連絡先を取り寄せた結果（決定 2026-08-21）。
 *
 * ⚠️ **`AdminActionState` に相乗りさせない。** あちらの `notice` は
 * 「操作が通りました」を伝える欄で、そこへアドレスを載せると、ほかの
 * 操作の成功メッセージと同じ扱いになる——**そのうち画面のどこかへ
 * 使い回される**。別の型にして、通り道を 1 本に絞る。
 */
export interface CustomerEmailState {
  readonly status: 'idle' | 'resolved' | 'unknown' | 'unavailable' | 'not_configured' | 'error';
  /** ⚠️ `status === 'resolved'` のときだけ入る。 */
  readonly email?: string;
  readonly error?: string;
}

export const CUSTOMER_EMAIL_IDLE: CustomerEmailState = { status: 'idle' };

/**
 * ご連絡先そのものを取り寄せる。
 *
 * ⚠️ **押されたときだけ動く。** 画面を開いただけでは呼ばない。開くたびに
 * 呼ぶと、監査ログが「開いた人」で埋まり、**本当に読んだ人が埋もれる**。
 * また、肩越しに見えてしまう場面も増える。
 *
 * ⚠️ **`revalidatePath` を呼ばない。** 何も変わっていないうえ、呼ぶと
 * この結果ごと描き直されて消える。
 *
 * ⚠️ **取り寄せた値をここへ残さない。** 変数から出さず、そのまま返す。
 * サーバー側でも保存していない（`UD-503`）。
 */
export async function revealCustomerEmailAction(
  _previous: CustomerEmailState,
  form: FormData,
): Promise<CustomerEmailState> {
  const accountId = text(form, 'accountId');
  const result = await fetchCustomerEmail(accountId);
  if (!result.ok) {
    return { status: 'error', error: adminErrorMessage(result.reason, result.code) };
  }
  return result.data.status === 'resolved'
    ? { status: 'resolved', email: result.data.email }
    : { status: result.data.status };
}
