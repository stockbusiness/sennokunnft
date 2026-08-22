'use client';

import { useActionState } from 'react';
import { Notice } from '@sengoku/ui';
import { REFUND_REQUEST_COPY as COPY } from '../../../src/refund-request-copy';
import { answerRefundInquiryAction } from './actions';
import type { ActionState } from '../actions';

const INITIAL: ActionState = {};

/**
 * 事実確認へのご回答。
 *
 * ⚠️ **「返金してよい・いけない」を選ぶ欄を置かない。** 伺うのは事実で、
 * 決めるのは運営である。
 *
 * ⚠️ **期限を過ぎていても、欄を閉じない。** 遅れて届いた事実にも値打ちが
 * ある。閉じると「もう関係ない」と読める。
 */
export function AnswerInquiryForm({
  requestId,
  expired,
}: {
  readonly requestId: string;
  readonly expired: boolean;
}) {
  const [state, action, pending] = useActionState(answerRefundInquiryAction, INITIAL);

  return (
    <form className="sengoku-form" action={action}>
      {state.error === undefined ? null : <Notice tone="alert" title={state.error} />}
      {state.done !== true ? null : <Notice tone="info" title={COPY.creatorSent} />}

      <input type="hidden" name="requestId" value={requestId} />

      {!expired ? null : <Notice tone="info" title={COPY.creatorExpiredHint} />}

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor={`inquiry-answer-${requestId}`}>
          {COPY.creatorAnswerLabel}
        </label>
        <textarea
          className="sengoku-form__input"
          id={`inquiry-answer-${requestId}`}
          name="answer"
          rows={4}
          required
        />
        <p className="sengoku-form__hint">{COPY.creatorAnswerHint}</p>
      </div>

      <button className="sengoku-button" type="submit" disabled={pending}>
        {pending ? COPY.creatorSending : COPY.creatorSubmit}
      </button>
    </form>
  );
}
