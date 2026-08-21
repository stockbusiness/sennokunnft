'use server';

import { revalidatePath } from 'next/cache';
import { recordAttestation, runMailCheck } from '../../../src/admin-client';
import { adminErrorMessage } from '../../../src/admin-copy';
import type { AdminActionState } from '../actions';

/**
 * 本番販売ガードの操作（P0-7）。
 *
 * ⚠️ **証跡は消せない。** 押す前に確かめてもらう文言を画面へ出す。
 * ここに取り消しの口を作らない。
 */

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

export async function recordAttestationAction(
  _previous: AdminActionState,
  form: FormData,
): Promise<AdminActionState> {
  const kind = text(form, 'kind');
  const note = text(form, 'note');
  const succeeded = text(form, 'succeeded') === 'true';

  const result = await recordAttestation({
    kind,
    succeeded,
    note: note === '' ? null : note,
  });
  if (!result.ok) {
    return { error: adminErrorMessage(result.reason, result.code) };
  }

  revalidatePath('/admin/production');
  revalidatePath('/admin');
  return {
    notice: '記録しました。',
    // ⚠️ 「これで売れます」と言わない。条件は毎回確かめ直される。
    noticeHint: '条件は毎回確かめ直されます。上の一覧でご確認ください。',
  };
}

export async function mailCheckAction(
  _previous: AdminActionState,
  _form: FormData,
): Promise<AdminActionState> {
  const result = await runMailCheck();
  if (!result.ok) {
    return { error: adminErrorMessage(result.reason, result.code) };
  }

  revalidatePath('/admin/production');
  revalidatePath('/admin/integrations');

  if (!result.data.succeeded) {
    return {
      error: `試し送りに失敗しました（${result.data.failureCode ?? '理由不明'}）。送信の設定をご確認ください。`,
    };
  }
  return {
    notice: `${result.data.maskedRecipient ?? 'あなたのアドレス'} へ送りました。`,
    /*
      ⚠️ **「届いた」と言わない。** 送信事業者が受け付けたところまでしか
         こちらには分からない。受信箱を見てもらう必要がある。
    */
    noticeHint: '受信箱に届いているかをご確認ください。届いていなければ、設定を見直してください。',
  };
}
