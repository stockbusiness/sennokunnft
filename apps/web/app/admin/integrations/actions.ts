'use server';

import { revalidatePath } from 'next/cache';
import {
  activateIntegrationSecret,
  checkIntegration,
  discardIntegrationSecret,
  registerIntegrationSecret,
  setIntegrationEnabled,
  updateIntegration,
  type AdminResult,
} from '../../../src/admin-client';
import { adminErrorMessage } from '../../../src/admin-copy';
import { INTEGRATION_COPY } from '../../../src/integration-copy';
import type { AdminActionState } from '../actions';

/**
 * 外部連携の設定（管理画面・外部連携 指示書 §4・§6・§9）。
 *
 * ⚠️ **ここは受け渡しだけを行う。判定はすべて API 側。**
 * 「接続確認が要る」「古い成功では通さない」といった規則を画面側にも書くと、
 * 2 か所に同じ規則ができて必ずずれる。
 *
 * ⚠️ **鍵の値を、どこにも残さない。** 通知の文面にも、状態にも入れない。
 * 入れた瞬間、それはブラウザの履歴と Server Action の応答に載る。
 */

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function fail<T>(result: AdminResult<T>): AdminActionState {
  return { error: result.ok ? undefined : adminErrorMessage(result.reason, result.code) };
}

function refresh(service: string): void {
  revalidatePath(`/admin/integrations/${service}`);
  revalidatePath('/admin/integrations');
}

export async function updateIntegrationAction(
  _previous: AdminActionState,
  form: FormData,
): Promise<AdminActionState> {
  const service = text(form, 'service');
  const rowVersion = Number.parseInt(text(form, 'rowVersion'), 10);
  if (!Number.isSafeInteger(rowVersion)) {
    return { error: '画面を読み込み直してから、もう一度お試しください。' };
  }

  const timeoutMs = Number.parseInt(text(form, 'timeoutMs'), 10);
  const maxAttempts = Number.parseInt(text(form, 'maxAttempts'), 10);
  if (!Number.isSafeInteger(timeoutMs) || !Number.isSafeInteger(maxAttempts)) {
    // 数として読めない入力だけ手前で止める。範囲の妥当性は API が判定する。
    return { error: '待つ上限と送り直す回数は、数字で入力してください。' };
  }

  const result = await updateIntegration(service, {
    endpointUrl: text(form, 'endpointUrl'),
    keyId: text(form, 'keyId'),
    apiVersion: text(form, 'apiVersion'),
    timeoutMs,
    maxAttempts,
    rowVersion,
  });
  if (!result.ok) {
    return fail(result);
  }
  refresh(service);
  /*
    ⚠️ **「保存した」と「繋がる」を混ぜない。** 保存できただけで
       繋がる保証は無い。ここで言い切ると、確認せずに有効化される。
  */
  return { notice: INTEGRATION_COPY.settingsSavedNotice };
}

/**
 * 鍵をお預かりする。
 *
 * ⚠️ **値を通知に載せない。** 「◯◯を登録しました」と書きたくなるが、
 * その文面はブラウザの履歴に残る。返すのは「預かった」ことだけ。
 */
export async function registerSecretAction(
  _previous: AdminActionState,
  form: FormData,
): Promise<AdminActionState> {
  const service = text(form, 'service');
  const value = text(form, 'value');
  if (value.length < 8) {
    return { error: '鍵は 8 文字以上です。提携先からお知らせされた値をご確認ください。' };
  }

  const result = await registerIntegrationSecret(service, { purpose: 'hmac_secret', value });
  if (!result.ok) {
    return fail(result);
  }
  refresh(service);
  return { notice: INTEGRATION_COPY.secretSavedNotice };
}

export async function activateSecretAction(
  _previous: AdminActionState,
  form: FormData,
): Promise<AdminActionState> {
  const result = await activateIntegrationSecret(text(form, 'secretId'));
  if (!result.ok) {
    return fail(result);
  }
  refresh(text(form, 'service'));
  return {};
}

export async function discardSecretAction(
  _previous: AdminActionState,
  form: FormData,
): Promise<AdminActionState> {
  const result = await discardIntegrationSecret(text(form, 'secretId'));
  if (!result.ok) {
    return fail(result);
  }
  refresh(text(form, 'service'));
  return {};
}

/**
 * 接続を確かめる。
 *
 * ⚠️ **結果を「成功」の 2 文字で返さない。** 確かめたのは到達性までで、
 * 鍵が正しいかどうかは分からない。画面側でその但し書きを必ず出す。
 */
export async function checkIntegrationAction(
  _previous: AdminActionState,
  form: FormData,
): Promise<AdminActionState> {
  const service = text(form, 'service');
  const result = await checkIntegration(service);
  if (!result.ok) {
    return fail(result);
  }
  refresh(service);

  const check = result.data.lastCheck;
  if (check === null) {
    return {};
  }
  return {
    notice: check.succeeded ? INTEGRATION_COPY.checkOk : INTEGRATION_COPY.checkNg,
    noticeHint: INTEGRATION_COPY.checkLimitation,
  };
}

export async function setEnabledAction(
  _previous: AdminActionState,
  form: FormData,
): Promise<AdminActionState> {
  const service = text(form, 'service');
  const result = await setIntegrationEnabled(service, text(form, 'enabled') === 'true');
  if (!result.ok) {
    return fail(result);
  }
  refresh(service);
  return {};
}
