'use client';

import { useActionState } from 'react';
import { Notice } from '@sengoku/ui';
import { REFUND_COPY as COPY } from '../../../../src/order-copy';
import { refundOrderAction } from './actions';
import type { AdminActionState } from '../../actions';

const INITIAL: AdminActionState = {};

/**
 * 返金の操作（`UD-104` / `UD-120`）。
 *
 * ⚠️ **金額の入力欄を置かない。** お戻しするのは残額の全部で、
 * 一部返金は自動処理しない決定。欄を置くと、桁を 1 つ多く打った操作が
 * そのまま通る。**押せる操作を減らすことが、いちばん確実な守りになる。**
 *
 * ⚠️ **「発行が進んでいる」チェックは、はじめから出しておかない。**
 * API が一度断ってから、その注記とともに出し直す。最初から出すと、
 * 意味を読まずに入れる癖がつく。
 */
export function RefundForm({
  orderId,
  refundable,
}: {
  readonly orderId: string;
  /**
   * 返金の対象になりうるか。
   *
   * ⚠️ **これは保護ではない。** 判定は API 側にある。ここで隠すのは、
   * 押しても通らない操作を並べないためだけ。
   */
  readonly refundable: boolean;
}) {
  const [state, action, pending] = useActionState(refundOrderAction, INITIAL);

  if (!refundable) {
    return null;
  }

  const needsAcknowledge = state.error?.includes(COPY.acknowledgeLabel) ?? false;

  return (
    <form className="sengoku-form" action={action}>
      <input type="hidden" name="orderId" value={orderId} />

      {state.error === undefined ? null : <Notice tone="alert" title={state.error} />}
      {state.notice === undefined ? null : (
        <Notice tone="info" title={state.notice} hint={state.noticeHint ?? ''} />
      )}

      {/* ⚠️ 取り消せないことを、押す前に必ず書く。 */}
      <Notice tone="alert" title={COPY.warning} hint={COPY.hint} />

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor={`refund-reason-${orderId}`}>
          {COPY.reasonLabel}
        </label>
        <p className="sengoku-form__hint">{COPY.reasonOurFaultHint}</p>
        <select
          className="sengoku-form__input"
          id={`refund-reason-${orderId}`}
          name="reason"
          defaultValue="buyer_request"
        >
          <option value="buyer_request">{COPY.reasonBuyerRequest}</option>
          <option value="our_fault">{COPY.reasonOurFault}</option>
        </select>
      </div>

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor={`refund-note-${orderId}`}>
          {COPY.noteLabel}
        </label>
        <p className="sengoku-form__hint">{COPY.noteHint}</p>
        <textarea
          className="sengoku-form__input"
          id={`refund-note-${orderId}`}
          name="note"
          rows={3}
        />
      </div>

      {needsAcknowledge ? (
        <div className="sengoku-form__field">
          <label className="sengoku-form__label" htmlFor={`refund-ack-${orderId}`}>
            <input id={`refund-ack-${orderId}`} name="acknowledgeIssued" type="checkbox" />{' '}
            {COPY.acknowledgeLabel}
          </label>
          <p className="sengoku-form__hint">{COPY.acknowledgeHint}</p>
        </div>
      ) : null}

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor={`refund-confirm-${orderId}`}>
          {COPY.confirmLabel}
        </label>
        <input
          className="sengoku-form__input"
          id={`refund-confirm-${orderId}`}
          name="confirm"
          type="text"
          autoComplete="off"
        />
      </div>

      <button className="sengoku-button" type="submit" disabled={pending}>
        {pending ? COPY.submitting : COPY.submit}
      </button>
    </form>
  );
}
