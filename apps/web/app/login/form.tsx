'use client';

import { useActionState } from 'react';
import { Notice } from '@sengoku/ui';
import { sendLinkAction, type LoginState } from './actions';
import { LOGIN_COPY } from '../../src/auth/copy';

const INITIAL: LoginState = {};

export function LoginForm({ next, expired }: { readonly next: string; readonly expired: boolean }) {
  const [state, action, pending] = useActionState(sendLinkAction, INITIAL);

  if (state.sent === true) {
    return (
      <>
        <Notice tone="info" title={LOGIN_COPY.sentTitle} hint={LOGIN_COPY.sentHint} />
        <p className="sengoku-form__hint">{LOGIN_COPY.note}</p>
      </>
    );
  }

  return (
    <>
      {expired ? (
        <Notice
          tone="alert"
          title={LOGIN_COPY.linkExpiredTitle}
          hint={LOGIN_COPY.linkExpiredHint}
        />
      ) : null}

      <form className="sengoku-form" action={action}>
        {state.error === undefined ? null : <Notice tone="alert" title={state.error} />}
        <input type="hidden" name="next" value={next} />

        <div className="sengoku-form__field">
          <label className="sengoku-form__label" htmlFor="email">
            {LOGIN_COPY.fieldEmail}
          </label>
          <p className="sengoku-form__hint">{LOGIN_COPY.fieldEmailHint}</p>
          <input
            className="sengoku-form__input"
            id="email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            required
            autoFocus
          />
        </div>

        <button className="sengoku-button" type="submit" disabled={pending}>
          {pending ? LOGIN_COPY.submitting : LOGIN_COPY.submit}
        </button>
      </form>

      <p className="sengoku-form__hint">{LOGIN_COPY.note}</p>
    </>
  );
}
