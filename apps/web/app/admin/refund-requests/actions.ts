'use server';

import { revalidatePath } from 'next/cache';
import {
  approveRefundRequest,
  askRefundCreator,
  executeRefundRequest,
  investigateRefundRequest,
  openRefundRequest,
  rejectRefundRequest,
  type AdminResult,
} from '../../../src/admin-client';
import { adminErrorMessage, type AdminFailureReason } from '../../../src/admin-copy';
import { REFUND_REQUEST_COPY as COPY } from '../../../src/refund-request-copy';
import type { AdminActionState } from '../actions';

/**
 * 返金の申請と審査の操作（方針整理 2026-08-22）。
 *
 * ⚠️ **ここは受け渡しだけ。判定はすべて API 側。** 「二重承認が要る額か」
 * 「作家さまへ聞ける事由か」を画面にも書くと、2 か所に同じ規則ができて
 * 必ずずれる。**画面はしきい値を知らないままでよい。**
 *
 * ⚠️ **押せない操作をボタンで隠して済ませない。** 隠しても API は直接
 * 叩けるし、隠すだけでは「なぜ押せないか」が伝わらない。断られた符号を
 * 言葉に直して返す。
 */

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function checked(form: FormData, name: string): boolean {
  return form.get(name) === 'on';
}

function refresh(id?: string): void {
  revalidatePath('/admin/refund-requests');
  if (id !== undefined) {
    revalidatePath(`/admin/refund-requests/${id}`);
  }
}

/**
 * 断られたときの言葉。
 *
 * ⚠️ **`REFUND_REQUEST_NOT_ACTIONABLE` を「権限がありません」と読ませない。**
 * 権限はある。その申し出では押せないだけである。権限の話にすると、
 * 運営が権限を足そうとして、いつまでも直らない。
 */
function refundError<T>(result: AdminResult<T>): string {
  if (result.ok) {
    return '';
  }
  switch (result.code) {
    case 'REFUND_REQUEST_NOT_ACTIONABLE':
      return 'この操作は、いまのお申し出の状態では行えません。画面を読み込み直して、最新の状態をご確認ください。';
    case 'REFUND_REQUEST_SAME_PERSON':
      return 'この金額は、お申し出をされたご本人とは別の方のご承認が必要です。もう一名の運営の方へお声かけください。';
    case 'REFUND_REQUEST_ALREADY_OPEN':
      return 'このご注文には、まだ決着していないお申し出があります。そちらをご確認ください。';
    case 'REFUND_AMOUNT_INVALID':
      return '金額を受け付けられませんでした。1 円以上、お返しできる残りまでの範囲でご入力ください。';
    case 'REFUND_REQUEST_INVALID':
      return 'お申し出の内容を受け付けられませんでした。事由と経緯をお確かめください。';
    case 'SETTLEMENT_SETTINGS_MISSING':
      return '返金と精算の取り決めが登録されていません。先に「返金と精算」の画面でご登録ください。';
    case 'REFUND_ALREADY_DONE':
      return 'このご注文は、すでに全額をお返ししています。';
    case 'PAYMENT_PROVIDER_DISABLED':
      return 'この配備では決済会社へ接続していないため、お返しの手続きを送れません。';
    default:
      break;
  }
  if (result.reason === 'unauthorized') {
    // ⚠️ **承認だけがオーナー限定。** どの操作で断られたかは呼ぶ側が知っている。
    return COPY.approveForbidden;
  }
  return adminErrorMessage(result.reason as AdminFailureReason, result.code);
}

/** 運営が代わりにお受けする。⚠️ 押した人が「お申し出をされた方」になる。 */
export async function openRefundRequestAction(
  _previous: AdminActionState,
  form: FormData,
): Promise<AdminActionState> {
  const orderId = text(form, 'orderId');
  const reason = text(form, 'reason');
  if (orderId === '' || reason === '') {
    return { error: 'ご注文の番号と事由をご入力ください。' };
  }

  const statement = text(form, 'statement');
  const note = text(form, 'note');
  const result = await openRefundRequest({
    orderId,
    reason: reason as never,
    ...(statement === '' ? {} : { statement }),
    ...(note === '' ? {} : { note }),
  });
  if (!result.ok) {
    return { error: refundError(result) };
  }

  refresh(result.data.id);
  return { notice: COPY.opened };
}

/** 作家さまへ事実確認を依頼する。⚠️ 期限は送らない（設定から決まる）。 */
export async function askCreatorAction(
  _previous: AdminActionState,
  form: FormData,
): Promise<AdminActionState> {
  const id = text(form, 'requestId');
  const note = text(form, 'note');
  const result = await askRefundCreator(id, note === '' ? undefined : note);
  if (!result.ok) {
    return { error: refundError(result) };
  }

  refresh(id);
  return { notice: COPY.asked };
}

/** 調べ終える。⚠️ 承認ではない。 */
export async function investigateAction(
  _previous: AdminActionState,
  form: FormData,
): Promise<AdminActionState> {
  const id = text(form, 'requestId');
  const note = text(form, 'note');
  if (note === '') {
    return { error: `${COPY.investigateNoteLabel}をご入力ください。` };
  }

  const result = await investigateRefundRequest(id, note);
  if (!result.ok) {
    return { error: refundError(result) };
  }

  refresh(id);
  return { notice: COPY.investigated };
}

/**
 * 承認する。
 *
 * ⚠️ **金額は打ち直された値をそのまま送る。** 画面に出ている額で補わない
 * ——補うと、再入力を課した意味が無くなる。
 * ⚠️ **数字以外は API へ渡す前に断る。** `Number()` は空文字を 0 にするので、
 * 「入力し忘れ」が「0 円の承認」として送られる。
 */
export async function approveAction(
  _previous: AdminActionState,
  form: FormData,
): Promise<AdminActionState> {
  const id = text(form, 'requestId');
  const raw = text(form, 'amount');
  if (!/^\d+$/u.test(raw)) {
    return { error: `${COPY.approveAmountLabel}を半角の数字でご入力ください。` };
  }
  const amount = Number.parseInt(raw, 10);
  if (amount <= 0) {
    return { error: COPY.approveAmountHint };
  }

  const disposition = text(form, 'entitlementDisposition');
  if (disposition !== 'revoke' && disposition !== 'keep') {
    return { error: `${COPY.approveDispositionLabel}をお選びください。` };
  }

  /*
    誰が被るか（決定 2026-08-22）。
    ⚠️ **知らない値は送らない。** 画面は 2 択だが、要求は作り替えられる。
       既定へ落とすのではなく断る——黙って既定にすると、送った側は
       選んだつもりのまま違う結果になる。
  */
  const bearer = text(form, 'clawbackBearer');
  if (bearer !== '' && bearer !== 'platform' && bearer !== 'creator') {
    return { error: `${COPY.bearerLabel}をお選びください。` };
  }

  const note = text(form, 'note');
  const approveAsException = checked(form, 'approveAsException');
  const result = await approveRefundRequest(id, {
    amount,
    entitlementDisposition: disposition,
    ...(approveAsException ? { approveAsException: true } : {}),
    ...(bearer === '' ? {} : { clawbackBearer: bearer }),
    ...(note === '' ? {} : { note }),
  });
  if (!result.ok) {
    return { error: refundError(result) };
  }

  refresh(id);
  /*
    ⚠️ **1 人目と最終承認で言葉を変える。** 同じ「承認しました」だと、
       1 人目が押した時点で送れると思われる。
  */
  return {
    notice: result.data.status === 'approval_pending' ? COPY.approvedFirst : COPY.approved,
  };
}

/** 却下する。⚠️ 理由が必ず残る。 */
export async function rejectAction(
  _previous: AdminActionState,
  form: FormData,
): Promise<AdminActionState> {
  const id = text(form, 'requestId');
  const rejectionNote = text(form, 'rejectionNote');
  if (rejectionNote === '') {
    return { error: `${COPY.rejectNoteLabel}をご入力ください。` };
  }

  const result = await rejectRefundRequest(id, rejectionNote);
  if (!result.ok) {
    return { error: refundError(result) };
  }

  refresh(id);
  return { notice: COPY.rejected };
}

/**
 * 決済会社へ送る。
 *
 * ⚠️ **失敗しても「もう一度」と促さない。** 送れなかったのか、送ったあとに
 * 落ちたのかは、ここからは分からない。断られた符号をそのまま言葉にする。
 */
export async function executeAction(
  _previous: AdminActionState,
  form: FormData,
): Promise<AdminActionState> {
  const id = text(form, 'requestId');
  const result = await executeRefundRequest(id);
  if (!result.ok) {
    return { error: refundError(result) };
  }

  refresh(id);
  return { notice: COPY.executed(result.data.amountRefunded) };
}
