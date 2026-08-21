'use server';

import { revalidatePath } from 'next/cache';
import { redeliverForAccount, retryIssuance } from '../../../src/admin-client';
import { adminErrorMessage } from '../../../src/admin-copy';
import type { AdminActionState } from '../actions';

/**
 * 受取権の手当て（実運営 指示書 P0-6 §9.3）。
 *
 * ⚠️ **ここに判定を書かない。** 「発行し直してよいか」「送り直してよいか」は
 * すべて API 側が決める。画面にも同じ規則を書くと、2 か所で必ずずれる。
 *
 * ⚠️ **禁止された操作の口をここに作らない。** 金額の書き換え、`paid` への
 * 手動変更、在庫と無関係な予約、記録を残さない状態変更は、この画面からも
 * API にも存在しない。
 *
 * ⚠️ **何も起きなかったことを黙らせない。** すでに全部そろっていたときに
 * 無言で戻ると、押した人は「直った」と思って次へ進む。
 */

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

export async function retryIssuanceAction(
  _previous: AdminActionState,
  form: FormData,
): Promise<AdminActionState> {
  const orderId = text(form, 'orderId');
  const result = await retryIssuance(orderId);
  if (!result.ok) {
    return { error: adminErrorMessage(result.reason, result.code) };
  }

  revalidatePath('/admin/entitlements');
  revalidatePath('/admin');

  if (result.data.alreadyComplete) {
    return {
      notice: '発行し直す必要はありませんでした。',
      noticeHint: 'このご注文ぶんの受取権は、すでにすべてそろっています。',
    };
  }
  return {
    notice: `${String(result.data.issuedCount)} 件の受取権を発行しました。`,
    noticeHint: 'ウォレットへのお届けは、このあとの巡回で行われます。',
  };
}

export async function redeliverAction(
  _previous: AdminActionState,
  form: FormData,
): Promise<AdminActionState> {
  const accountId = text(form, 'accountId');
  const result = await redeliverForAccount(accountId);
  if (!result.ok) {
    return { error: adminErrorMessage(result.reason, result.code) };
  }

  revalidatePath('/admin/entitlements');
  revalidatePath('/admin/wallet-deliveries');
  revalidatePath('/admin');

  const { pickedCount, deliveredCount, skippedCount, failedCount } = result.data;
  if (pickedCount === 0) {
    return {
      notice: '送り直すものはありませんでした。',
      noticeHint: 'この方ぶんのお届けは、すでにすべて済んでいます。',
    };
  }
  return {
    notice: `${String(pickedCount)} 件を送り直しました。`,
    /*
      ⚠️ **失敗した数を隠さない。** 「送り直しました」だけを出すと、
         1 件も届いていなくても成功に見える。
    */
    noticeHint: `お届けできた ${String(deliveredCount)} 件 / 見送った ${String(skippedCount)} 件 / できなかった ${String(failedCount)} 件`,
  };
}
