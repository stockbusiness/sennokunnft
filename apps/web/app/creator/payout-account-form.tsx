'use client';

import { useActionState } from 'react';
import { Notice } from '@sengoku/ui';
import type { PayoutAccountView } from '@sengoku/contracts';
import { savePayoutAccountAction, type ActionState } from './actions';
import { CREATOR_COPY } from '../../src/creator-copy';

const INITIAL: ActionState = {};

/**
 * お振込先を登録するフォーム（P1-3・`UD-124` 決定 2026-08-21）。
 *
 * ⚠️ **誰の分かを送らない。** アカウントは API がトークンから決める。
 * 隠し欄で送れる形にすると、**そこが他人の支払先を差し替える道になる**
 * ——この仕組みでいちばん実入りのある攻撃である。
 *
 * ⚠️ **口座番号を初期値に入れない。** 読み戻しには伏せた表記しか無く、
 * それを初期値にすると `***4567` がそのまま保存されうる。**番号だけは
 * 毎回打ち直していただく**——お金の行き先が変わる操作なので、
 * 打ち直す手間は歯止めとしても働く。
 *
 * ⚠️ **本人確認書類の欄は無い**（`UD-124`）。取らないと決めたものは、
 * 入力欄そのものを作らない。
 */
export function PayoutAccountForm({ current }: { current: PayoutAccountView | null }) {
  const [state, action, pending] = useActionState(savePayoutAccountAction, INITIAL);

  return (
    <form className="sengoku-form" action={action}>
      {state.error === undefined ? null : <Notice tone="alert" title={state.error} />}
      {state.done === true ? <Notice title={CREATOR_COPY.payoutAccountSaved} /> : null}

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="bankName">
          {CREATOR_COPY.fieldBankName}
        </label>
        <p className="sengoku-form__hint">{CREATOR_COPY.fieldBankNameHint}</p>
        <input
          className="sengoku-form__input"
          id="bankName"
          name="bankName"
          type="text"
          maxLength={60}
          defaultValue={current?.bankName ?? ''}
          required
        />
      </div>

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="branchName">
          {CREATOR_COPY.fieldBranchName}
        </label>
        <p className="sengoku-form__hint">{CREATOR_COPY.fieldBranchNameHint}</p>
        <input
          className="sengoku-form__input"
          id="branchName"
          name="branchName"
          type="text"
          maxLength={60}
          defaultValue={current?.branchName ?? ''}
          required
        />
      </div>

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="accountType">
          {CREATOR_COPY.fieldAccountType}
        </label>
        <select
          className="sengoku-form__input"
          id="accountType"
          name="accountType"
          defaultValue={current?.accountType ?? 'ordinary'}
        >
          {/* ⚠️ 通帳の表記に合わせる。「普通預金」ではなく「普通」。 */}
          <option value="ordinary">普通</option>
          <option value="checking">当座</option>
        </select>
      </div>

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="accountNumber">
          {CREATOR_COPY.fieldAccountNumber}
        </label>
        <p className="sengoku-form__hint">{CREATOR_COPY.fieldAccountNumberHint}</p>
        {/*
          ⚠️ **登録済みでも初期値を入れない。** 伏せた表記しか手元に無く、
             入れると `***4567` がそのまま保存されうる。
        */}
        {current === null ? null : (
          <p className="sengoku-form__hint">{`いまご登録の口座: ${current.maskedAccountNumber}`}</p>
        )}
        <input
          className="sengoku-form__input"
          id="accountNumber"
          name="accountNumber"
          type="text"
          inputMode="numeric"
          maxLength={32}
          required
        />
      </div>

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="accountHolderKana">
          {CREATOR_COPY.fieldAccountHolder}
        </label>
        <p className="sengoku-form__hint">{CREATOR_COPY.fieldAccountHolderHint}</p>
        <input
          className="sengoku-form__input"
          id="accountHolderKana"
          name="accountHolderKana"
          type="text"
          maxLength={60}
          defaultValue={current?.accountHolderKana ?? ''}
          required
        />
      </div>

      {/* ⚠️ 知らせが飛ぶことを、押す前に伝える。 */}
      <p className="sengoku-form__hint">{CREATOR_COPY.payoutAccountChangeHint}</p>

      <button className="sengoku-button" type="submit" disabled={pending}>
        {pending ? '登録しています…' : CREATOR_COPY.submitPayoutAccount}
      </button>
    </form>
  );
}
