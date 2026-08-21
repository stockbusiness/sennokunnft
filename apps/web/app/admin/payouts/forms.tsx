'use client';

import { useActionState } from 'react';
import { Notice } from '@sengoku/ui';
import { PAYOUT_COPY as COPY } from '../../../src/payout-copy';
import { formatDateTime } from '../../../src/order-copy';
import { payoutAccountTypeLabel } from '../../../src/payout-copy';
import {
  closePayoutPeriodAction,
  confirmPayoutAction,
  markPayoutPaidAction,
  revealPayoutAccountAction,
  PAYOUT_ACCOUNT_IDLE,
  type PayoutAccountState,
} from './actions';
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

/**
 * 振込のために、お振込先を読む（決定 2026-08-21）。
 *
 * ⚠️ **押されるまで読まない。** 画面を開いただけで読むと、監査ログが
 * 「開いた人」で埋まり、**本当に読んだ人が埋もれる**。
 *
 * ⚠️ **読み取った値を画面の外へ持ち出さない。** 再描画で消える。次に
 * 要るときは、また押していただく（記録がもう 1 行増える）。
 */
export function RevealPayoutAccountForm({ payoutId }: { readonly payoutId: string }) {
  const [state, action, pending] = useActionState(revealPayoutAccountAction, PAYOUT_ACCOUNT_IDLE);

  return (
    <form className="sengoku-form" action={action}>
      <input type="hidden" name="payoutId" value={payoutId} />
      {state.status === 'idle' ? <p className="sengoku-form__hint">{COPY.revealNotice}</p> : null}
      <PayoutAccountResult state={state} />
      <button className="sengoku-button sengoku-button--quiet" type="submit" disabled={pending}>
        {pending
          ? COPY.revealing
          : state.status === 'idle'
            ? COPY.revealButton
            : COPY.revealAgainButton}
      </button>
    </form>
  );
}

/**
 * 読み取った結果。
 *
 * ⚠️ **「取れなかった」を一色にしない。** 運営の次の一手が違う——
 * 未登録なら作家さまへお願いし、鍵が無ければ運用担当へ伝え、
 * **解けなければ振り込まない**。同じ顔で出すと、いちばん危ない
 * 「解けなかった」が「あとで直る不具合」に見える。
 */
function PayoutAccountResult({ state }: { readonly state: PayoutAccountState }) {
  switch (state.status) {
    case 'idle':
      return null;
    case 'resolved':
      return (
        <dl className="sengoku-facts">
          <dt>{COPY.accountFieldBank}</dt>
          {/* ⚠️ 文字として描く。HTML として解釈しない。 */}
          <dd>{state.bankName}</dd>
          <dt>{COPY.accountFieldBranch}</dt>
          <dd>{state.branchName}</dd>
          <dt>{COPY.accountFieldType}</dt>
          <dd>{payoutAccountTypeLabel(state.accountType)}</dd>
          <dt>{COPY.accountFieldNumber}</dt>
          {/* ⚠️ 選んで写せるようにする。打ち直しは打ち間違いのもと。 */}
          <dd>
            <code>{state.accountNumber}</code>
          </dd>
          <dt>{COPY.accountFieldHolder}</dt>
          <dd>
            <code>{state.accountHolderKana}</code>
          </dd>
          <dt>{COPY.accountFieldUpdatedAt}</dt>
          <dd>
            {formatDateTime(state.updatedAt)}
            <span className="sengoku-form__hint"> {COPY.accountUpdatedAtHint}</span>
          </dd>
        </dl>
      );
    case 'missing':
      return <Notice tone="alert" title={COPY.accountMissing} hint={COPY.accountMissingHint} />;
    case 'not_configured':
      return (
        <Notice tone="alert" title={COPY.accountUnavailable} hint={COPY.accountUnavailableHint} />
      );
    case 'undecipherable':
      return (
        <Notice
          tone="alert"
          title={COPY.revealUndecipherable}
          hint={COPY.revealUndecipherableHint}
        />
      );
    case 'not_payable_yet':
      return (
        <Notice tone="info" title={COPY.revealNotPayableYet} hint={COPY.revealNotPayableYetHint} />
      );
    case 'error':
      return <Notice tone="alert" title={state.error} />;
  }
}
