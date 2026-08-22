'use client';

import { useActionState } from 'react';
import { Notice } from '@sengoku/ui';
import { BUYER_REFUND_REASON_VALUES } from '@sengoku/contracts';
import {
  clawbackBearerLabel,
  REFUND_REQUEST_COPY as COPY,
  refundReasonLabel,
} from '../../../src/refund-request-copy';
import {
  approveAction,
  askCreatorAction,
  executeAction,
  investigateAction,
  openRefundRequestAction,
  rejectAction,
} from './actions';
import type { AdminActionState } from '../actions';

const INITIAL: AdminActionState = {};

function Messages({ state }: { readonly state: AdminActionState }) {
  return (
    <>
      {state.error === undefined ? null : <Notice tone="alert" title={state.error} />}
      {state.notice === undefined ? null : <Notice tone="info" title={state.notice} />}
    </>
  );
}

/**
 * 運営が代わりにお受けする。
 *
 * ⚠️ **事由の選択肢は購入者と同じ組にしている。** 運営だけが選べる事由
 * （不正利用の疑い・渡し違い）を代理申請から選べるようにすると、
 * 「購入者からの申し出」として記録されたものに、購入者が言うはずのない
 * 事由が混ざる。それらは調査のうえで運営が判断して付け替える筋である。
 */
export function OpenRefundRequestForm() {
  const [state, action, pending] = useActionState(openRefundRequestAction, INITIAL);

  return (
    <form className="sengoku-form" action={action}>
      <Messages state={state} />
      <p className="sengoku-form__hint">{COPY.openHint}</p>

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="refund-open-order">
          {COPY.openOrderLabel}
        </label>
        <input
          className="sengoku-form__input"
          id="refund-open-order"
          name="orderId"
          type="text"
          required
        />
      </div>

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="refund-open-reason">
          {COPY.fieldReason}
        </label>
        <select className="sengoku-form__input" id="refund-open-reason" name="reason" required>
          {BUYER_REFUND_REASON_VALUES.map((reason) => (
            <option key={reason} value={reason}>
              {refundReasonLabel(reason)}
            </option>
          ))}
        </select>
      </div>

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="refund-open-statement">
          {COPY.buyerStatementHeading}
        </label>
        <textarea
          className="sengoku-form__input"
          id="refund-open-statement"
          name="statement"
          rows={3}
        />
      </div>

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="refund-open-note">
          {COPY.noteHeading}
        </label>
        <textarea className="sengoku-form__input" id="refund-open-note" name="note" rows={2} />
        <p className="sengoku-form__hint">{COPY.noteHint}</p>
      </div>

      <button className="sengoku-button" type="submit" disabled={pending}>
        {pending ? COPY.opening : COPY.openSubmit}
      </button>
    </form>
  );
}

/** 作家さまへ事実確認を依頼する。⚠️ 期限を入力する欄は置かない。 */
export function AskCreatorForm({ requestId }: { readonly requestId: string }) {
  const [state, action, pending] = useActionState(askCreatorAction, INITIAL);

  return (
    <form className="sengoku-form" action={action}>
      <Messages state={state} />
      <input type="hidden" name="requestId" value={requestId} />
      <p className="sengoku-form__hint">{COPY.askCreatorHint}</p>

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="refund-ask-note">
          {COPY.askCreatorNoteLabel}
        </label>
        <textarea className="sengoku-form__input" id="refund-ask-note" name="note" rows={2} />
      </div>

      <button className="sengoku-button" type="submit" disabled={pending}>
        {pending ? COPY.asking : COPY.askCreatorSubmit}
      </button>
    </form>
  );
}

/** 調べ終える。⚠️ 承認ではない、と分かる言葉にする。 */
export function InvestigateForm({ requestId }: { readonly requestId: string }) {
  const [state, action, pending] = useActionState(investigateAction, INITIAL);

  return (
    <form className="sengoku-form" action={action}>
      <Messages state={state} />
      <input type="hidden" name="requestId" value={requestId} />
      <p className="sengoku-form__hint">{COPY.investigateHint}</p>

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="refund-investigate-note">
          {COPY.investigateNoteLabel}
        </label>
        <textarea
          className="sengoku-form__input"
          id="refund-investigate-note"
          name="note"
          rows={3}
          required
        />
        <p className="sengoku-form__hint">{COPY.noteHint}</p>
      </div>

      <button className="sengoku-button" type="submit" disabled={pending}>
        {pending ? COPY.investigating : COPY.investigateSubmit}
      </button>
    </form>
  );
}

/**
 * 承認する。
 *
 * ⚠️ **金額の欄を空で出す。** 申し出の額を `defaultValue` に入れると、
 * そのまま押せてしまい、**打ち直しを課した意味が無くなる**。残額は
 * すぐ上に出ているので、読んで打っていただく。
 *
 * ⚠️ **原則対象外は、断りのチェックを 1 つ挟む。** 押し慣れで越えられる
 * ようにしない。
 */
export function ApproveForm({
  requestId,
  remainingAmount,
  isExcluded,
  bearer,
}: {
  readonly requestId: string;
  readonly remainingAmount: number;
  readonly isExcluded: boolean;
  /** ⚠️ 事由から決まる値。画面では読むだけ。 */
  readonly bearer: 'platform' | 'creator';
}) {
  const [state, action, pending] = useActionState(approveAction, INITIAL);

  return (
    <form className="sengoku-form" action={action}>
      <Messages state={state} />
      <input type="hidden" name="requestId" value={requestId} />
      <p className="sengoku-form__hint">{COPY.approveHint}</p>

      <p>
        {COPY.fieldRemaining}: <strong>{remainingAmount.toLocaleString('ja-JP')} 円</strong>
      </p>

      {/*
        ⚠️ **押す前に、誰が被るかを見せる。** 見えないまま押すと、作家さまの
           売上から引かれることに気づかないまま承認できてしまう。
        ⚠️ **選ばせない。** 事由から決まる。選べるようにすると、一度の操作で
           作家さまへ費用を寄せられる。
      */}
      <p>
        {COPY.bearerLabel}: <strong>{clawbackBearerLabel(bearer)}</strong>
      </p>
      <p className="sengoku-form__hint">{COPY.bearerHint}</p>

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="refund-approve-amount">
          {COPY.approveAmountLabel}
        </label>
        <input
          className="sengoku-form__input"
          id="refund-approve-amount"
          name="amount"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          required
        />
        <p className="sengoku-form__hint">{COPY.approveAmountHint}</p>
      </div>

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="refund-approve-disposition">
          {COPY.approveDispositionLabel}
        </label>
        <select
          className="sengoku-form__input"
          id="refund-approve-disposition"
          name="entitlementDisposition"
          required
        >
          <option value="revoke">{COPY.approveDispositionRevoke}</option>
          <option value="keep">{COPY.approveDispositionKeep}</option>
        </select>
        <p className="sengoku-form__hint">{COPY.approveDispositionHint}</p>
      </div>

      {!isExcluded ? null : (
        <div className="sengoku-form__field">
          <label className="sengoku-form__label" htmlFor="refund-approve-exception">
            <input id="refund-approve-exception" name="approveAsException" type="checkbox" />{' '}
            {COPY.approveExceptionLabel}
          </label>
          <p className="sengoku-form__hint">{COPY.approveExceptionHint}</p>
        </div>
      )}

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="refund-approve-note">
          {COPY.approveNoteLabel}
        </label>
        <textarea className="sengoku-form__input" id="refund-approve-note" name="note" rows={2} />
        <p className="sengoku-form__hint">{COPY.noteHint}</p>
      </div>

      <button className="sengoku-button" type="submit" disabled={pending}>
        {pending ? COPY.approving : COPY.approveSubmit}
      </button>
    </form>
  );
}

/** 却下する。⚠️ 理由が必ず残る。 */
export function RejectForm({ requestId }: { readonly requestId: string }) {
  const [state, action, pending] = useActionState(rejectAction, INITIAL);

  return (
    <form className="sengoku-form" action={action}>
      <Messages state={state} />
      <input type="hidden" name="requestId" value={requestId} />
      <p className="sengoku-form__hint">{COPY.rejectHint}</p>

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="refund-reject-note">
          {COPY.rejectNoteLabel}
        </label>
        <textarea
          className="sengoku-form__input"
          id="refund-reject-note"
          name="rejectionNote"
          rows={3}
          required
        />
      </div>

      <button className="sengoku-button" type="submit" disabled={pending}>
        {pending ? COPY.rejecting : COPY.rejectSubmit}
      </button>
    </form>
  );
}

/**
 * 決済会社へ送る。
 *
 * ⚠️ **「入金された」と読める言葉を出さない。** 受け付けられたところまで。
 */
export function ExecuteForm({ requestId }: { readonly requestId: string }) {
  const [state, action, pending] = useActionState(executeAction, INITIAL);

  return (
    <form className="sengoku-form" action={action}>
      <Messages state={state} />
      <input type="hidden" name="requestId" value={requestId} />
      <p className="sengoku-form__hint">{COPY.executeHint}</p>
      <Notice tone="alert" title={COPY.executeCaution} />

      <button className="sengoku-button" type="submit" disabled={pending}>
        {pending ? COPY.executing : COPY.executeSubmit}
      </button>
    </form>
  );
}
