'use client';

import { useActionState } from 'react';
import { Notice } from '@sengoku/ui';
import type { IntegrationStatusView } from '@sengoku/contracts';
import {
  activateSecretAction,
  checkIntegrationAction,
  discardSecretAction,
  registerSecretAction,
  setEnabledAction,
  updateIntegrationAction,
  updatePaymentSettingsAction,
} from './actions';
import type { AdminActionState } from '../actions';
import { INTEGRATION_COPY } from '../../../src/integration-copy';

const INITIAL: AdminActionState = {};

function Messages({ state }: { readonly state: AdminActionState }) {
  return (
    <>
      {state.error === undefined ? null : <Notice tone="alert" title={state.error} />}
      {state.notice === undefined || state.notice === '' ? null : (
        <Notice tone="info" title={state.notice} hint={state.noticeHint ?? ''} />
      )}
    </>
  );
}

/**
 * 接続先の設定。
 *
 * ⚠️ **読んだときの版（`rowVersion`）をそのまま書き戻す。** 別の画面で
 * 先に保存されていたら、API が断る。黙って上書きさせない。
 */
export function SettingsForm({ status }: { readonly status: IntegrationStatusView }) {
  const [state, action, pending] = useActionState(updateIntegrationAction, INITIAL);
  return (
    <form className="sengoku-form" action={action}>
      <Messages state={state} />
      <input type="hidden" name="service" value={status.service} />
      <input type="hidden" name="rowVersion" value={String(status.rowVersion)} />

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="endpointUrl">
          {INTEGRATION_COPY.fieldEndpoint}
        </label>
        <p className="sengoku-form__hint">{INTEGRATION_COPY.fieldEndpointHint}</p>
        <input
          className="sengoku-form__input"
          id="endpointUrl"
          name="endpointUrl"
          type="url"
          inputMode="url"
          autoComplete="off"
          defaultValue={status.endpointUrl ?? ''}
        />
      </div>

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="keyId">
          {INTEGRATION_COPY.fieldKeyId}
        </label>
        <p className="sengoku-form__hint">{INTEGRATION_COPY.fieldKeyIdHint}</p>
        <input
          className="sengoku-form__input"
          id="keyId"
          name="keyId"
          type="text"
          autoComplete="off"
          defaultValue={status.keyId ?? ''}
        />
      </div>

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="apiVersion">
          {INTEGRATION_COPY.fieldApiVersion}
        </label>
        <input
          className="sengoku-form__input"
          id="apiVersion"
          name="apiVersion"
          type="text"
          autoComplete="off"
          defaultValue={status.apiVersion ?? ''}
        />
      </div>

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="timeoutMs">
          {INTEGRATION_COPY.fieldTimeout}
        </label>
        <input
          className="sengoku-form__input"
          id="timeoutMs"
          name="timeoutMs"
          type="number"
          inputMode="numeric"
          defaultValue={String(status.timeoutMs)}
        />
      </div>

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="maxAttempts">
          {INTEGRATION_COPY.fieldMaxAttempts}
        </label>
        <input
          className="sengoku-form__input"
          id="maxAttempts"
          name="maxAttempts"
          type="number"
          inputMode="numeric"
          defaultValue={String(status.maxAttempts)}
        />
      </div>

      <button className="sengoku-button" type="submit" disabled={pending}>
        {pending ? '保存しています…' : INTEGRATION_COPY.submitSettings}
      </button>
    </form>
  );
}

/**
 * お支払いの設定。
 *
 * ⚠️ **接続先と鍵の名前は出さない。** 決済会社の宛先は決まっていて
 * 変える意味が無く、鍵の識別子という概念も無い。無い欄を並べると、
 * 埋めるための嘘の値が入る。
 *
 * ⚠️ **手数料 0 を「無料」と書かない。** 0 は「まだ決めていない」。
 * 画面がそこを取り違えると、設定した人も取り違える。
 */
export function PaymentSettingsForm({ status }: { readonly status: IntegrationStatusView }) {
  const [state, action, pending] = useActionState(updatePaymentSettingsAction, INITIAL);
  const payment = status.payment;
  if (payment === null) {
    return null;
  }
  return (
    <form className="sengoku-form" action={action}>
      <Messages state={state} />
      <input type="hidden" name="service" value={status.service} />
      <input type="hidden" name="rowVersion" value={String(status.rowVersion)} />

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="checkoutSuccessUrl">
          {INTEGRATION_COPY.fieldSuccessUrl}
        </label>
        <p className="sengoku-form__hint">{INTEGRATION_COPY.fieldSuccessUrlHint}</p>
        <input
          className="sengoku-form__input"
          id="checkoutSuccessUrl"
          name="checkoutSuccessUrl"
          type="text"
          inputMode="url"
          autoComplete="off"
          defaultValue={payment.checkoutSuccessUrl ?? ''}
        />
      </div>

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="checkoutCancelUrl">
          {INTEGRATION_COPY.fieldCancelUrl}
        </label>
        <p className="sengoku-form__hint">{INTEGRATION_COPY.fieldCancelUrlHint}</p>
        <input
          className="sengoku-form__input"
          id="checkoutCancelUrl"
          name="checkoutCancelUrl"
          type="text"
          inputMode="url"
          autoComplete="off"
          defaultValue={payment.checkoutCancelUrl ?? ''}
        />
      </div>

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="feeRatePercent">
          {INTEGRATION_COPY.fieldFeeRate}
        </label>
        <p className="sengoku-form__hint">{INTEGRATION_COPY.fieldFeeRateHint}</p>
        {/*
          ⚠️ **画面は％で受け、送るのは bps。** ％で持つと小数になり、
             金額の計算に浮動小数が混ざる。変換はここ 1 か所だけで行う。
        */}
        <input
          className="sengoku-form__input"
          id="feeRatePercent"
          name="feeRatePercent"
          type="number"
          inputMode="decimal"
          min="0"
          max="100"
          step="0.01"
          defaultValue={String(payment.platformFeeRateBps / 100)}
        />
      </div>

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="paymentApiVersion">
          {INTEGRATION_COPY.fieldApiVersion}
        </label>
        <input
          className="sengoku-form__input"
          id="paymentApiVersion"
          name="apiVersion"
          type="text"
          autoComplete="off"
          defaultValue={payment.apiVersion ?? ''}
        />
      </div>

      <button className="sengoku-button" type="submit" disabled={pending}>
        {pending ? '保存しています…' : INTEGRATION_COPY.submitSettings}
      </button>
    </form>
  );
}

/**
 * 鍵をお預かりする。
 *
 * ⚠️ **入力欄を `type="password"` にする。** 肩越しに見られる場面と、
 * ブラウザの自動入力に拾われる場面の両方を減らす。
 *
 * ⚠️ **保存後に値を出さない。** 画面へ返るのは末尾 4 文字までで、
 * それ以上は API が返さない。
 */
export function SecretForm({ service }: { readonly service: string }) {
  const [state, action, pending] = useActionState(registerSecretAction, INITIAL);
  return (
    <form className="sengoku-form" action={action}>
      <Messages state={state} />
      <input type="hidden" name="service" value={service} />

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="secretValue">
          {INTEGRATION_COPY.fieldSecret}
        </label>
        <p className="sengoku-form__hint">{INTEGRATION_COPY.fieldSecretHint}</p>
        <input
          className="sengoku-form__input"
          id="secretValue"
          name="value"
          type="password"
          autoComplete="off"
          spellCheck={false}
          required
        />
      </div>

      <button className="sengoku-button" type="submit" disabled={pending}>
        {pending ? 'お預かりしています…' : INTEGRATION_COPY.submitSecret}
      </button>
    </form>
  );
}

export function SecretActionButton({
  service,
  secretId,
  kind,
}: {
  readonly service: string;
  readonly secretId: string;
  readonly kind: 'activate' | 'discard';
}) {
  const [state, action, pending] = useActionState(
    kind === 'activate' ? activateSecretAction : discardSecretAction,
    INITIAL,
  );
  return (
    <form className="sengoku-inline-form" action={action}>
      <Messages state={state} />
      <input type="hidden" name="service" value={service} />
      <input type="hidden" name="secretId" value={secretId} />
      <button className="sengoku-button sengoku-button--quiet" type="submit" disabled={pending}>
        {pending
          ? '処理しています…'
          : kind === 'activate'
            ? INTEGRATION_COPY.submitActivate
            : INTEGRATION_COPY.submitDiscard}
      </button>
    </form>
  );
}

export function CheckButton({ service }: { readonly service: string }) {
  const [state, action, pending] = useActionState(checkIntegrationAction, INITIAL);
  return (
    <form className="sengoku-form" action={action}>
      <Messages state={state} />
      <input type="hidden" name="service" value={service} />
      <button className="sengoku-button" type="submit" disabled={pending}>
        {pending ? '確かめています…' : INTEGRATION_COPY.submitCheck}
      </button>
    </form>
  );
}

/**
 * お届けの開始と停止。
 *
 * ⚠️ **止めるボタンは、条件に関わらず必ず出す。** 事故を止める操作なので、
 * いつでも押せなければならない。
 */
export function EnableButton({
  service,
  enabled,
  canEnable,
}: {
  readonly service: string;
  readonly enabled: boolean;
  readonly canEnable: boolean;
}) {
  const [state, action, pending] = useActionState(setEnabledAction, INITIAL);

  if (!enabled && !canEnable) {
    // ⚠️ 押せるのに何も起きないボタンを置かない。理由を先に出す。
    return (
      <Notice
        tone="info"
        title={INTEGRATION_COPY.enableBlocked}
        hint={INTEGRATION_COPY.enableBlockedHint}
      />
    );
  }

  return (
    <form className="sengoku-form" action={action}>
      <Messages state={state} />
      <input type="hidden" name="service" value={service} />
      <input type="hidden" name="enabled" value={enabled ? 'false' : 'true'} />
      <button
        className={`sengoku-button${enabled ? ' sengoku-button--quiet' : ''}`}
        type="submit"
        disabled={pending}
      >
        {pending
          ? '処理しています…'
          : enabled
            ? INTEGRATION_COPY.submitDisable
            : INTEGRATION_COPY.submitEnable}
      </button>
      {enabled ? <p className="sengoku-form__hint">{INTEGRATION_COPY.disableHint}</p> : null}
    </form>
  );
}
