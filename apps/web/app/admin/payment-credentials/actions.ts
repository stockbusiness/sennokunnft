'use server';

import { revalidatePath } from 'next/cache';
import {
  actOnPaymentCredential,
  registerPaymentCredential,
  checkPaymentCredential,
  type AdminResult,
} from '../../../src/admin-client';
import { paymentCredentialError } from '../../../src/payment-credential-copy';
import type { AdminActionState } from '../actions';

/**
 * 決済資格情報の世代の操作（`UD-118`）。
 *
 * ⚠️ **ここは受け渡しだけ。判定はすべて API 側。** 「接続テストを通らないと
 * 有効化できない」「受付中は退役させられない」を画面にも書くと、2 か所に
 * 同じ規則ができて必ずずれる。
 *
 * ⚠️ **鍵をここに残さない。** 受け取ってすぐ送り、状態にも通知にも載せない。
 */

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function fail<T>(result: AdminResult<T>): AdminActionState {
  return { error: result.ok ? undefined : paymentCredentialError(result.code, result.reason) };
}

function refresh(): void {
  revalidatePath('/admin/payment-credentials');
}

export async function registerCredentialAction(
  _previous: AdminActionState,
  form: FormData,
): Promise<AdminActionState> {
  const secretKey = text(form, 'secretKey');
  const webhookSecret = text(form, 'webhookSecret');
  if (secretKey === '' || webhookSecret === '') {
    return { error: '秘密鍵と Webhook 署名鍵の両方を入力してください。' };
  }

  const label = text(form, 'label');
  const apiVersion = text(form, 'apiVersion');
  const result = await registerPaymentCredential({
    secretKey,
    webhookSecret,
    label: label === '' ? null : label,
    apiVersion: apiVersion === '' ? null : apiVersion,
  });
  if (!result.ok) {
    return fail(result);
  }

  refresh();
  return {
    notice: '登録しました。続けて接続テストを行ってください。',
    noticeHint: '登録しただけでは、まだ新規のお支払いには使われません。',
  };
}

export async function checkCredentialAction(
  _previous: AdminActionState,
  form: FormData,
): Promise<AdminActionState> {
  const result = await checkPaymentCredential(text(form, 'id'));
  if (!result.ok) {
    return fail(result);
  }
  refresh();
  return { notice: '接続テストを行いました。結果を一覧でご確認ください。' };
}

/**
 * 有効化・受付切替・退役。
 *
 * ⚠️ **本番では確認の入力が要る。** 押し慣れを防ぐため、API 側が
 * 「production」の入力を求める。画面はそれを送るだけ。
 */
export async function credentialActionAction(
  _previous: AdminActionState,
  form: FormData,
): Promise<AdminActionState> {
  const action = text(form, 'action');
  if (
    action !== 'activate' &&
    action !== 'stop-accepting' &&
    action !== 'resume-accepting' &&
    action !== 'retire'
  ) {
    return { error: '操作を選んでください。' };
  }

  const confirmation = text(form, 'confirmation');
  const result = await actOnPaymentCredential(
    text(form, 'id'),
    action,
    confirmation === '' ? null : confirmation,
  );
  if (!result.ok) {
    return fail(result);
  }

  refresh();
  return { notice: '反映しました。' };
}
