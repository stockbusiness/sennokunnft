'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  createCheckoutSession,
  orderErrorMessage,
  submitRefundRequest,
} from '../../../../src/order-client';
import { ORDER_COPY } from '../../../../src/order-copy';
import { REFUND_REQUEST_COPY } from '../../../../src/refund-request-copy';

/**
 * お支払いのページへ送る。
 *
 * ⚠️ **送り先はサーバーが決める。** ブラウザから受け取った URL へ
 * 飛ばす形にすると、偽の支払いページへ誘導できる。
 */
export interface PayActionState {
  readonly error?: string;
}

export async function startPaymentAction(
  _previous: PayActionState,
  form: FormData,
): Promise<PayActionState> {
  const orderId = typeof form.get('orderId') === 'string' ? String(form.get('orderId')) : '';
  if (orderId === '') {
    return { error: 'お手続きの情報が読み取れませんでした。' };
  }

  const result = await createCheckoutSession(orderId);
  if (!result.ok) {
    /*
      ⚠️ **404 を「注文が見つかりません」と訳さない。** この画面は
         自分の注文を開いた状態から押されている。ここで 404 が返るのは、
         配備に決済がまだ繋がっておらず**経路そのものが無い**とき。
         「見つかりません」と出すと、注文が消えたように読める。
    */
    if (result.reason === 'not_found') {
      return { error: ORDER_COPY.setupIncompleteHint };
    }
    return { error: orderErrorMessage(result) };
  }

  // ⚠️ redirect は例外を投げて処理を抜ける。try の中へ入れない。
  redirect(result.data.checkoutUrl);
}

/**
 * 返金のご相談を出す（方針整理 2026-08-22）。
 *
 * ⚠️ **「ご返金します」と読める言葉を返さない。** お受けしただけである。
 * 返るかどうかは審査が決める。ここで約束すると、断ったときに話が違うと
 * なる——そして、それはこちらの書き方が悪い。
 */
export interface RefundRequestActionState {
  readonly error?: string;
  readonly done?: boolean;
}

export async function submitRefundRequestAction(
  _previous: RefundRequestActionState,
  form: FormData,
): Promise<RefundRequestActionState> {
  const orderId = typeof form.get('orderId') === 'string' ? String(form.get('orderId')) : '';
  const reason = typeof form.get('reason') === 'string' ? String(form.get('reason')).trim() : '';
  const statement =
    typeof form.get('statement') === 'string' ? String(form.get('statement')).trim() : '';

  if (orderId === '' || reason === '') {
    return { error: 'ご事情をお選びください。' };
  }
  if (statement.length < 10) {
    return { error: REFUND_REQUEST_COPY.buyerStatementHint };
  }

  const result = await submitRefundRequest(orderId, { reason, statement });
  if (!result.ok) {
    if (result.reason === 'rejected' && result.code === 'REFUND_REQUEST_ALREADY_OPEN') {
      return { error: REFUND_REQUEST_COPY.buyerAlreadyOpen };
    }
    if (result.reason === 'rejected' && result.code === 'REFUND_ALREADY_DONE') {
      return { error: 'このご注文は、すでにご返金が済んでいます。' };
    }
    return { error: orderErrorMessage(result) };
  }

  revalidatePath(`/account/orders/${orderId}`);
  return { done: true };
}
