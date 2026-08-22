'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Notice } from '@sengoku/ui';
import { BUYER_REFUND_REASON_VALUES } from '@sengoku/contracts';
import { startPaymentAction, submitRefundRequestAction, type PayActionState } from './actions';
import { ORDER_COPY } from '../../../../src/order-copy';
import { buyerRefundReasonLabel, REFUND_REQUEST_COPY } from '../../../../src/refund-request-copy';

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

/**
 * 返金のご相談（方針整理 2026-08-22）。
 *
 * ⚠️ **金額をご入力いただく欄を置かない。** どれだけお返しするかは審査が
 * 決める。打てるようにすると、その額が約束に見える。
 *
 * ⚠️ **たたんでおく。** お支払いが済んだ画面にいつも開いた状態で置くと、
 * 「返せる」ことのほうが先に目に入る。
 *
 * ⚠️ **お受けしたことと、お返しすることを分けて書く。** ここを曖昧にすると、
 * 断ったときに「話が違う」となる——そしてそれは、こちらの書き方が悪い。
 */
export function RefundRequestForm({ orderId }: { readonly orderId: string }) {
  const [state, action, pending] = useActionState(submitRefundRequestAction, {});

  if (state.done === true) {
    return <Notice tone="info" title={REFUND_REQUEST_COPY.buyerSent} />;
  }

  return (
    <details className="sengoku-panel">
      <summary>{REFUND_REQUEST_COPY.buyerHeading}</summary>

      <form className="sengoku-form" action={action}>
        {state.error === undefined ? null : <Notice tone="alert" title={state.error} />}

        <p className="sengoku-form__hint">{REFUND_REQUEST_COPY.buyerHint}</p>
        <p className="sengoku-form__hint">{REFUND_REQUEST_COPY.buyerCaution}</p>

        <input type="hidden" name="orderId" value={orderId} />

        <div className="sengoku-form__field">
          <label className="sengoku-form__label" htmlFor="refund-reason">
            {REFUND_REQUEST_COPY.buyerReasonLabel}
          </label>
          <select className="sengoku-form__input" id="refund-reason" name="reason" required>
            {BUYER_REFUND_REASON_VALUES.map((reason) => (
              <option key={reason} value={reason}>
                {buyerRefundReasonLabel(reason)}
              </option>
            ))}
          </select>
        </div>

        <div className="sengoku-form__field">
          <label className="sengoku-form__label" htmlFor="refund-statement">
            {REFUND_REQUEST_COPY.buyerStatementLabel}
          </label>
          <textarea
            className="sengoku-form__input"
            id="refund-statement"
            name="statement"
            rows={4}
            minLength={10}
            required
          />
          <p className="sengoku-form__hint">{REFUND_REQUEST_COPY.buyerStatementHint}</p>
        </div>

        <button className="sengoku-button" type="submit" disabled={pending}>
          {pending ? REFUND_REQUEST_COPY.buyerSending : REFUND_REQUEST_COPY.buyerSubmit}
        </button>
      </form>
    </details>
  );
}
