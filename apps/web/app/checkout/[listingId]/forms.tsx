'use client';

import { useActionState } from 'react';
import { Notice } from '@sengoku/ui';
import { createOrderAction, type CheckoutState } from './actions';
import { ORDER_COPY } from '../../../src/order-copy';

const INITIAL: CheckoutState = {};

/**
 * お申し込みのボタン。
 *
 * ⚠️ **二度押しを 2 か所で止める。** 押している間はボタンを無効にし、
 * それでも 2 回届いたときのために、同じ重複防止キーを送る。
 * 画面側だけで止めると、通信が遅い端末で二重注文になる。
 *
 * ⚠️ **キーを描画のたびに作らない。** サーバー側で 1 回作ったものを
 * hidden で受け取る。ここで作ると、再描画のたびに別のキーになる。
 */
export function CheckoutForm({
  listingId,
  idempotencyKey,
}: {
  readonly listingId: string;
  readonly idempotencyKey: string;
}) {
  const [state, action, pending] = useActionState(createOrderAction, INITIAL);
  return (
    <form className="sengoku-form" action={action}>
      {state.error === undefined ? null : (
        <Notice tone="alert" title={state.error} hint={ORDER_COPY.retryHint} />
      )}
      <input type="hidden" name="listingId" value={listingId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <button className="sengoku-button sengoku-button--large" type="submit" disabled={pending}>
        {pending ? ORDER_COPY.submittingCheckout : ORDER_COPY.submitCheckout}
      </button>
    </form>
  );
}
