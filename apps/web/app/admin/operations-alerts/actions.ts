'use server';

import { revalidatePath } from 'next/cache';
import { saveOperationsAlertSettings } from '../../../src/admin-client';
import { adminErrorMessage, type AdminFailureReason } from '../../../src/admin-copy';
import { ALERT_COPY } from '../../../src/alert-copy';
import type { AdminActionState } from '../actions';

/**
 * 運営への知らせの設定（`UD-1102` の一部）。
 *
 * ⚠️ **ここは受け渡しだけ。判定はすべて API 側。** 宛先の形も間隔の範囲も
 * 画面に書くと、2 か所に同じ規則ができて必ずずれる。
 *
 * ⚠️ **受け口の URL をこの層へ残さない。** 受け取ってそのまま渡す。
 */

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

export async function saveOperationsAlertSettingsAction(
  _previous: AdminActionState,
  form: FormData,
): Promise<AdminActionState> {
  /*
    ⚠️ **改行で区切る。** 「, 区切り」にすると、貼り付けたアドレスに
       余計な空白が混じったときに気づけない。
  */
  const recipients = text(form, 'emailRecipients')
    .split(/\r?\n/u)
    .map((row) => row.trim())
    .filter((row) => row !== '');

  const clearWebhook = form.get('clearWebhook') === 'on';
  const webhookUrl = text(form, 'webhookUrl');

  const result = await saveOperationsAlertSettings({
    enabled: form.get('enabled') === 'on',
    minSeverity: form.get('minSeverity') === 'warning' ? 'warning' : 'critical',
    repeatAfterMinutes: Number(text(form, 'repeatAfterMinutes')),
    emailRecipients: recipients,
    /*
      ⚠️ **省略・空文字・値の 3 通りを保つ。**
        - 「外す」が押されていれば空文字（＝外す）
        - 何も入力されていなければ省略（＝変えない）
        - 入力されていればその値
    */
    ...(clearWebhook ? { webhookUrl: '' } : webhookUrl === '' ? {} : { webhookUrl }),
  });

  if (!result.ok) {
    return { error: adminErrorMessage(result.reason as AdminFailureReason, result.code) };
  }

  revalidatePath('/admin/operations-alerts');
  return { notice: ALERT_COPY.saved };
}
