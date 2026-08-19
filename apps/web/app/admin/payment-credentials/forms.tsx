'use client';

import { useActionState } from 'react';
import { Notice } from '@sengoku/ui';
import { checkCredentialAction, credentialActionAction, registerCredentialAction } from './actions';
import type { AdminActionState } from '../actions';
import { PAYMENT_CREDENTIAL_COPY } from '../../../src/payment-credential-copy';

const INITIAL: AdminActionState = {};

/**
 * 世代の登録。
 *
 * ⚠️ **鍵の入力欄は登録のときだけ。** 一度預けたら二度と表示しない。
 * 欄を再表示できる形にすると、画面から鍵が読めることになる。
 */
export function RegisterForm() {
  const [state, action, pending] = useActionState(registerCredentialAction, INITIAL);

  return (
    <form className="sengoku-form" action={action}>
      {state.error === undefined ? null : <Notice tone="alert" title={state.error} />}
      {state.notice === undefined ? null : (
        <Notice tone="info" title={state.notice} hint={state.noticeHint ?? ''} />
      )}

      <p className="sengoku-form__hint">{PAYMENT_CREDENTIAL_COPY.registerHint}</p>

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="cred-label">
          {PAYMENT_CREDENTIAL_COPY.fieldLabel}
        </label>
        <p className="sengoku-form__hint">{PAYMENT_CREDENTIAL_COPY.fieldLabelHint}</p>
        <input className="sengoku-form__input" id="cred-label" name="label" type="text" />
      </div>

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="cred-secret">
          {PAYMENT_CREDENTIAL_COPY.fieldSecretKey}
        </label>
        <p className="sengoku-form__hint">{PAYMENT_CREDENTIAL_COPY.fieldSecretKeyHint}</p>
        {/*
          ⚠️ `type="password"` にする。肩越しに見られるのを防ぐ。
          ⚠️ `autoComplete="off"` にする。ブラウザに保存させない。
        */}
        <input
          className="sengoku-form__input"
          id="cred-secret"
          name="secretKey"
          type="password"
          autoComplete="off"
          required
        />
      </div>

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="cred-webhook">
          {PAYMENT_CREDENTIAL_COPY.fieldWebhookSecret}
        </label>
        <input
          className="sengoku-form__input"
          id="cred-webhook"
          name="webhookSecret"
          type="password"
          autoComplete="off"
          required
        />
      </div>

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="cred-api-version">
          {PAYMENT_CREDENTIAL_COPY.fieldApiVersion}
        </label>
        <input
          className="sengoku-form__input"
          id="cred-api-version"
          name="apiVersion"
          type="text"
        />
      </div>

      <button className="sengoku-button" type="submit" disabled={pending}>
        {pending ? '登録しています…' : PAYMENT_CREDENTIAL_COPY.submitRegister}
      </button>
    </form>
  );
}

export function CheckButton({ id }: { readonly id: string }) {
  const [state, action, pending] = useActionState(checkCredentialAction, INITIAL);
  return (
    <form action={action}>
      <input type="hidden" name="id" value={id} />
      {state.error === undefined ? null : <Notice tone="alert" title={state.error} />}
      {state.notice === undefined ? null : <Notice tone="info" title={state.notice} />}
      <button className="sengoku-button sengoku-button--quiet" type="submit" disabled={pending}>
        {pending ? '確認しています…' : PAYMENT_CREDENTIAL_COPY.buttonCheck}
      </button>
    </form>
  );
}

/**
 * 有効化・受付切替・退役。
 *
 * ⚠️ **本番では確認の入力欄を出す。** 「本当によろしいですか」の一段だけに
 * しない。押し慣れると意味を失う。
 */
export function CredentialActionForm({
  id,
  action: actionName,
  label,
  needsConfirmation,
  warning,
}: {
  readonly id: string;
  readonly action: 'activate' | 'stop-accepting' | 'resume-accepting' | 'retire';
  readonly label: string;
  readonly needsConfirmation: boolean;
  readonly warning?: string;
}) {
  const [state, action, pending] = useActionState(credentialActionAction, INITIAL);

  return (
    <form className="sengoku-form" action={action}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="action" value={actionName} />
      {state.error === undefined ? null : <Notice tone="alert" title={state.error} />}
      {state.notice === undefined ? null : <Notice tone="info" title={state.notice} />}
      {warning === undefined ? null : (
        <Notice tone="info" title={warning} hint={PAYMENT_CREDENTIAL_COPY.activateWarningHint} />
      )}

      {needsConfirmation ? (
        <div className="sengoku-form__field">
          <label className="sengoku-form__label" htmlFor={`confirm-${id}-${actionName}`}>
            {PAYMENT_CREDENTIAL_COPY.confirmationLabel}
          </label>
          <p className="sengoku-form__hint">{PAYMENT_CREDENTIAL_COPY.confirmationHint}</p>
          <input
            className="sengoku-form__input"
            id={`confirm-${id}-${actionName}`}
            name="confirmation"
            type="text"
            autoComplete="off"
          />
        </div>
      ) : null}

      <button className="sengoku-button sengoku-button--quiet" type="submit" disabled={pending}>
        {pending ? '反映しています…' : label}
      </button>
    </form>
  );
}
