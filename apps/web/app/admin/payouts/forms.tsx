'use client';

import { useActionState } from 'react';
import { Notice } from '@sengoku/ui';
import { PAYOUT_COPY as COPY } from '../../../src/payout-copy';
import { closePayoutPeriodAction, confirmPayoutAction, markPayoutPaidAction } from './actions';
import type { AdminActionState } from '../actions';

const INITIAL: AdminActionState = {};

/**
 * その月を締める。
 *
 * ⚠️ **作家さまを選ばせない。** その期間に売上か繰越のある方は API が
 * 洗い出す。選べると、選び忘れた方がいつまでも支払われない——そして
 * 誰も気づかない。
 */
export function ClosePeriodForm({ defaultPeriod }: { readonly defaultPeriod: string }) {
  const [state, action, pending] = useActionState(closePayoutPeriodAction, INITIAL);

  return (
    <form className="sengoku-form" action={action}>
      {state.error === undefined ? null : <Notice tone="alert" title={state.error} />}
      {state.notice === undefined ? null : <Notice tone="info" title={state.notice} />}

      <p className="sengoku-form__hint">{COPY.closeHint}</p>

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="payout-period">
          {COPY.periodLabel}
        </label>
        <input
          className="sengoku-form__input"
          id="payout-period"
          name="periodKey"
          type="text"
          inputMode="numeric"
          placeholder={COPY.periodPlaceholder}
          defaultValue={defaultPeriod}
          required
        />
      </div>

      <button className="sengoku-button" type="submit" disabled={pending}>
        {pending ? COPY.closing : COPY.submitClose}
      </button>
    </form>
  );
}

/** 確定する。⚠️ 確定した内容は変更できない。 */
export function ConfirmPayoutForm({
  payoutId,
  openRefundWindows,
}: {
  readonly payoutId: string;
  readonly openRefundWindows: number;
}) {
  const [state, action, pending] = useActionState(confirmPayoutAction, INITIAL);

  /*
    ⚠️ **押せるのに効かないボタンを出さない。** 窓が開いているあいだは、
       押しても API が断る。理由を先に伝えて、ボタンを出さない。
    ⚠️ これは保護ではない。判定は API 側にある。
  */
  if (openRefundWindows > 0) {
    return (
      <Notice tone="info" title={COPY.windowOpen(openRefundWindows)} hint={COPY.windowOpenHint} />
    );
  }

  return (
    <form className="sengoku-form" action={action}>
      <input type="hidden" name="payoutId" value={payoutId} />
      {state.error === undefined ? null : <Notice tone="alert" title={state.error} />}
      {state.notice === undefined ? null : <Notice tone="info" title={state.notice} />}

      <Notice tone="alert" title={COPY.confirmWarning} hint={COPY.confirmHint} />

      <button className="sengoku-button" type="submit" disabled={pending}>
        {pending ? COPY.confirming : COPY.submitConfirm}
      </button>
    </form>
  );
}

/**
 * お支払い済みとして記録する。
 *
 * ⚠️ **この操作では振込は行われない。** いちばん誤解されやすいので、
 * ボタンの直前で必ず書く。
 */
export function MarkPaidForm({ payoutId }: { readonly payoutId: string }) {
  const [state, action, pending] = useActionState(markPayoutPaidAction, INITIAL);

  return (
    <form className="sengoku-form" action={action}>
      <input type="hidden" name="payoutId" value={payoutId} />
      {state.error === undefined ? null : <Notice tone="alert" title={state.error} />}
      {state.notice === undefined ? null : <Notice tone="info" title={state.notice} />}

      <Notice tone="alert" title={COPY.markPaidWarning} hint={COPY.markPaidHint} />

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor={`paid-confirm-${payoutId}`}>
          確認のため、下の欄に「振込済み」と入力してください
        </label>
        <input
          className="sengoku-form__input"
          id={`paid-confirm-${payoutId}`}
          name="confirm"
          type="text"
          autoComplete="off"
        />
      </div>

      <button className="sengoku-button" type="submit" disabled={pending}>
        {pending ? COPY.markingPaid : COPY.submitMarkPaid}
      </button>
    </form>
  );
}
