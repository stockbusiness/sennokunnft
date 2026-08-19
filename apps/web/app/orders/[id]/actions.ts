'use server';

import { redirect } from 'next/navigation';
import { createCheckoutSession, orderErrorMessage } from '../../../src/order-client';
import { ORDER_COPY } from '../../../src/order-copy';

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
