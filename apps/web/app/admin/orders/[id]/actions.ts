'use server';

import { revalidatePath } from 'next/cache';
import { addAdminOrderNote } from '../../../../src/admin-client';
import { adminErrorMessage } from '../../../../src/admin-copy';
import { ORDER_COPY } from '../../../../src/order-copy';
import type { AdminActionState } from '../../actions';

/**
 * 対応メモを足す（`UD-121`）。
 *
 * ⚠️ **直す口も消す口もここへ足さない。** API 側に存在しない。
 * 呼び出し側だけ用意すると「画面にはあるのに動かない」操作が残り、
 * いつか「動くように直そう」と言われる。
 *
 * ⚠️ **判定は API 側。** 「空でない」「2000 文字以内」「メールアドレスを
 * 含まない」の規則を画面にも書くと、2 か所に同じ規則ができて必ずずれる。
 * ここが見るのは「送る値があるか」までにとどめる。
 */
export async function addOrderNoteAction(
  _previous: AdminActionState,
  form: FormData,
): Promise<AdminActionState> {
  const rawId = form.get('orderId');
  const rawBody = form.get('body');
  const orderId = typeof rawId === 'string' ? rawId : '';
  const body = typeof rawBody === 'string' ? rawBody.trim() : '';

  if (orderId === '' || body === '') {
    return { error: ORDER_COPY.notesLabel + 'をご入力ください。' };
  }

  const result = await addAdminOrderNote(orderId, body);
  if (!result.ok) {
    /*
      ⚠️ **メールアドレスを含む場合の断りだけは、理由を具体的に伝える。**
         「保存できません」だけだと、何度も送り直すことになる。
         符号から引き当てるので、本文の文言をそのまま出してはいない。
    */
    if (result.code === 'ORDER_NOTE_INVALID') {
      return { error: ORDER_COPY.notesEmailWarning };
    }
    return { error: adminErrorMessage(result.reason) };
  }

  revalidatePath(`/admin/orders/${orderId}`);
  return {};
}
