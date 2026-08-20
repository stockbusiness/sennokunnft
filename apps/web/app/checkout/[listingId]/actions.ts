'use server';

import { redirect } from 'next/navigation';
import { createOrder, orderErrorMessage } from '../../../src/order-client';

/**
 * お申し込みを確定する。
 *
 * ⚠️ **重複防止キーはフォームが持って来たものを使う。** ここで作り直すと、
 * 二度押しのたびに別のキーになり、注文が 2 件できる。
 *
 * ⚠️ **金額を受け取らない。** 受け取るのは出品IDとキーだけ。
 * フォームに金額の欄を足さないこと（指示書 §4.2）。
 */
export interface CheckoutState {
  readonly error?: string;
}

export async function createOrderAction(
  _previous: CheckoutState,
  form: FormData,
): Promise<CheckoutState> {
  const listingId = typeof form.get('listingId') === 'string' ? String(form.get('listingId')) : '';
  const idempotencyKey =
    typeof form.get('idempotencyKey') === 'string' ? String(form.get('idempotencyKey')) : '';

  if (listingId === '' || idempotencyKey === '') {
    return { error: 'お手続きの情報が読み取れませんでした。作品のページからやり直してください。' };
  }

  const result = await createOrder({ listingId, idempotencyKey });
  if (!result.ok) {
    return { error: orderErrorMessage(result) };
  }

  // ⚠️ redirect は例外を投げて処理を抜ける。try の中へ入れない。
  redirect(`/account/orders/${result.data.id}`);
}
