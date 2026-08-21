'use server';

import { revalidatePath } from 'next/cache';
import { resendNotification } from '../../../src/admin-client';
import { adminErrorMessage } from '../../../src/admin-copy';
import type { AdminActionState } from '../actions';

/**
 * 知らせを送り直す（実運営 指示書 P0-4 / P0-6）。
 *
 * ⚠️ **送り直せるかどうかは API が決める。** 画面にも規則を書くと、
 * 2 か所に同じ規則ができて必ずずれる。
 *
 * ⚠️ **`{ requeued: false }` を成功として黙らせない。** 押したのに
 * 送信待ちへ戻らなかったことを、押した人へ伝える。
 */
export async function resendNotificationAction(
  _previous: AdminActionState,
  form: FormData,
): Promise<AdminActionState> {
  const raw = form.get('deliveryId');
  const deliveryId = typeof raw === 'string' ? raw.trim() : '';

  const result = await resendNotification(deliveryId);
  if (!result.ok) {
    return { error: adminErrorMessage(result.reason, result.code) };
  }

  revalidatePath('/admin/notifications');
  revalidatePath('/admin');

  if (!result.data.requeued) {
    return {
      notice: '送信待ちへは戻りませんでした。',
      noticeHint: 'すでに送信済みか、送り直せない状態です。一覧の状態をご確認ください。',
    };
  }
  return {
    notice: '送信待ちへ戻しました。',
    noticeHint: '次の巡回で送信します。しばらくしてから状態をご確認ください。',
  };
}
