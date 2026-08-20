'use server';

import { revalidatePath } from 'next/cache';
import { addAdminOrderNote, refundAdminOrder } from '../../../../src/admin-client';
import { adminErrorMessage, type AdminFailureReason } from '../../../../src/admin-copy';
import { ORDER_COPY, REFUND_COPY } from '../../../../src/order-copy';
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

/**
 * 返金する（`UD-104` / `UD-120`）。
 *
 * ⚠️ **金額を受け取らない。** 返すのは常に残額の全部。額を受け取る口を
 * 作ると、桁を 1 つ多く打った操作がそのまま通る。
 *
 * ⚠️ **判定は API 側。** 「期間内か」「発行がどこまで進んだか」を画面にも
 * 書くと、2 か所に同じ規則ができて必ずずれる。ここが見るのは、
 * 取り消せない操作の手前で手を止める仕掛け（合言葉）までにとどめる。
 */
export async function refundOrderAction(
  _previous: AdminActionState,
  form: FormData,
): Promise<AdminActionState> {
  const rawId = form.get('orderId');
  const orderId = typeof rawId === 'string' ? rawId : '';
  const rawReason = form.get('reason');
  const reason = rawReason === 'our_fault' ? 'our_fault' : 'buyer_request';

  /*
    ⚠️ **合言葉を要求する。** 「本当によろしいですか」の確認だけでは、
       返すつもりが無い人でも勢いで押せてしまう。取り消せない操作なので、
       手を止める仕掛けを 1 つ挟む。
    ⚠️ **これは保護ではない。** 画面を経由せずに API を叩けば通らない
       ので、返してよいかの判定は API 側にある。ここは事故を減らすだけ。
  */
  const confirm = form.get('confirm');
  if ((typeof confirm === 'string' ? confirm.trim() : '') !== REFUND_COPY.confirmWord) {
    return { error: REFUND_COPY.confirmMismatch };
  }

  const rawNote = form.get('note');
  const note = typeof rawNote === 'string' ? rawNote.trim() : '';

  const result = await refundAdminOrder(orderId, {
    reason,
    // ⚠️ 既定は false。押し慣れで越えられるようにしない。
    acknowledgeIssued: form.get('acknowledgeIssued') === 'on',
    ...(note === '' ? {} : { note }),
  });

  if (!result.ok) {
    return { error: refundErrorMessage(result.code, result.reason) };
  }

  revalidatePath(`/admin/orders/${orderId}`);
  revalidatePath('/admin/orders');

  /*
    ⚠️ **「返金しました」で終わらせない。** 取り消せなかったお渡しの
       処理があれば、必ず伝える。丸めると、運営は片づいたと思って
       画面を閉じる。
  */
  if (result.data.annotatedMintJobs > 0) {
    return { notice: REFUND_COPY.annotatedWarning, noticeHint: REFUND_COPY.annotatedHint };
  }
  return { notice: REFUND_COPY.succeeded };
}

/**
 * 断られたときの言葉。
 *
 * ⚠️ **`REFUND_NEEDS_REVIEW` を「できません」にしない。** 機械が決めない
 * だけで、判断のうえで返すことはある。チェックを入れて出し直せることを
 * 伝える。
 */
function refundErrorMessage(code: string | undefined, reason: AdminFailureReason): string {
  if (code === 'REFUND_NEEDS_REVIEW') {
    return `${REFUND_COPY.acknowledgeHint} お戻しする場合は「${REFUND_COPY.acknowledgeLabel}」にチェックを入れて、もう一度お進みください。`;
  }
  if (code === 'REFUND_WINDOW_CLOSED') {
    return 'お受けする期間を過ぎています。当方の不具合が原因の場合は、理由を「当方の不具合」にしてお進みください。';
  }
  if (code === 'REFUND_ALREADY_DONE') {
    return 'このご注文はすでに全額をお戻ししています。';
  }
  if (code === 'REFUND_CREDENTIAL_UNAVAILABLE') {
    return 'このご注文をお預かりした当時の決済用の鍵が見つからないため、返金できません。オーナーにご連絡ください。';
  }
  if (code === 'REFUND_PROVIDER_ERROR') {
    return '決済事業者へ依頼が届きませんでした。記録は残っていますので、しばらくしてからもう一度お試しください。';
  }
  return adminErrorMessage(reason, code);
}
