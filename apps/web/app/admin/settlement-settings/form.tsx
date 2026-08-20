'use client';

import { useActionState } from 'react';
import type { SettlementSettingsView } from '@sengoku/contracts';
import { Notice } from '@sengoku/ui';
import { SETTLEMENT_COPY as COPY } from '../../../src/settlement-copy';
import { updateSettlementSettingsAction } from './actions';
import type { AdminActionState } from '../actions';

const INITIAL: AdminActionState = {};

/**
 * 取り決めの入力（`UD-104` / `UD-119`）。
 *
 * ⚠️ **未設定のときに既定値を埋めない。** 空欄のまま出す。埋めると、
 * 誰も決めていない値が「決まっているもの」として保存される。
 *
 * ⚠️ **`min` / `max` は親切であって保護ではない。** ブラウザは外せる。
 * 範囲の判定は API 側（`validateSettlementSettings`）にある。
 */
export function SettlementSettingsForm({
  current,
}: {
  readonly current: SettlementSettingsView | null;
}) {
  const [state, action, pending] = useActionState(updateSettlementSettingsAction, INITIAL);

  return (
    <form className="sengoku-form" action={action}>
      {state.error === undefined ? null : <Notice tone="alert" title={state.error} />}
      {state.notice === undefined ? null : (
        <Notice tone="info" title={state.notice} hint={state.noticeHint ?? ''} />
      )}

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="refund-window-days">
          {COPY.fieldRefundWindow}
        </label>
        <p className="sengoku-form__hint">{COPY.fieldRefundWindowHint}</p>
        <input
          className="sengoku-form__input"
          id="refund-window-days"
          name="refundWindowDays"
          type="number"
          inputMode="numeric"
          min={0}
          max={180}
          step={1}
          defaultValue={current?.refundWindowDays ?? ''}
          required
        />
      </div>

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="payout-offset-months">
          {COPY.fieldPayoutOffset}
        </label>
        <p className="sengoku-form__hint">{COPY.fieldPayoutOffsetHint}</p>
        <input
          className="sengoku-form__input"
          id="payout-offset-months"
          name="payoutOffsetMonths"
          type="number"
          inputMode="numeric"
          min={0}
          max={6}
          step={1}
          defaultValue={current?.payoutOffsetMonths ?? ''}
          required
        />
      </div>

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="minimum-payout-amount">
          {COPY.fieldMinimumPayout}
        </label>
        <p className="sengoku-form__hint">{COPY.fieldMinimumPayoutHint}</p>
        <input
          className="sengoku-form__input"
          id="minimum-payout-amount"
          name="minimumPayoutAmount"
          type="number"
          inputMode="numeric"
          min={0}
          max={100000}
          step={1}
          defaultValue={current?.minimumPayoutAmount ?? ''}
          required
        />
      </div>

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="transfer-fee-bearer">
          {COPY.fieldTransferFeeBearer}
        </label>
        <select
          className="sengoku-form__input"
          id="transfer-fee-bearer"
          name="transferFeeBearer"
          defaultValue={current?.transferFeeBearer ?? 'creator'}
        >
          <option value="creator">{COPY.bearerCreator}</option>
          <option value="platform">{COPY.bearerPlatform}</option>
        </select>
      </div>

      <button className="sengoku-button" type="submit" disabled={pending}>
        {pending ? COPY.submitting : COPY.submit}
      </button>
    </form>
  );
}
