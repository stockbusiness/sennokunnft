'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Notice } from '@sengoku/ui';
import { startPaymentAction, type PayActionState } from './actions';
import { ORDER_COPY } from '../../../src/order-copy';

const INITIAL: PayActionState = {};

/**
 * お支払いへ進むボタン。
 *
 * ⚠️ **二度押しを止める。** 押している間は無効にする。それでも 2 回
 * 届いたときは、サーバー側が同じ支払い口を使い回す（二段構え）。
 */
export function PayButton({
  orderId,
  reused,
}: {
  readonly orderId: string;
  readonly reused: boolean;
}) {
  const [state, action, pending] = useActionState(startPaymentAction, INITIAL);
  return (
    <form className="sengoku-form" action={action}>
      {state.error === undefined ? null : <Notice tone="alert" title={state.error} />}
      {reused ? <p className="sengoku-form__hint">{ORDER_COPY.payReuseNote}</p> : null}
      <input type="hidden" name="orderId" value={orderId} />
      <button className="sengoku-button sengoku-button--large" type="submit" disabled={pending}>
        {pending ? ORDER_COPY.submittingPay : ORDER_COPY.submitPay}
      </button>
    </form>
  );
}

/** 何回まで確認しに行くか。⚠️ 無制限にしない。 */
const MAX_POLLS = 20;
const POLL_INTERVAL_MS = 3000;

/**
 * お支払いの結果を待つ（指示書 §12）。
 *
 * ⚠️ **ブラウザが戻ってきたことを「完了」の根拠にしない。** 決済会社からの
 * 通知が届くまでは分からない。ここは「まだ分からない」を表示したまま、
 * サーバーへ聞き直すだけ。
 *
 * ⚠️ **無制限に聞き続けない。** 通知が来ないまま画面を開きっぱなしに
 * されると、要求だけが増える。一定回数で止めて、案内へ切り替える。
 */
export function PaymentResultPoller() {
  const router = useRouter();
  const [gaveUp, setGaveUp] = useState(false);

  useEffect(() => {
    let polls = 0;
    const timer = setInterval(() => {
      polls += 1;
      if (polls > MAX_POLLS) {
        clearInterval(timer);
        setGaveUp(true);
        return;
      }
      // サーバー側で描き直す。状態が変わっていれば表示も変わる。
      router.refresh();
    }, POLL_INTERVAL_MS);

    return () => {
      clearInterval(timer);
    };
  }, [router]);

  /*
    ⚠️ **「失敗しました」と言い切らない。** 通知が遅れているだけの
       ことがある。実際に受け付けられている可能性を残した言い方にする。
  */
  return gaveUp ? (
    <Notice
      tone="alert"
      title={ORDER_COPY.confirmingSlowTitle}
      hint={ORDER_COPY.confirmingSlowHint}
    />
  ) : (
    <Notice tone="info" title={ORDER_COPY.confirmingTitle} hint={ORDER_COPY.confirmingHint} />
  );
}
