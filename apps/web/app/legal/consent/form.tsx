'use client';

import { useActionState } from 'react';
import { Notice } from '@sengoku/ui';
import { recordConsentAction, type ConsentState } from './actions';
import { LEGAL_COPY } from '../../../src/legal-copy';

const INITIAL: ConsentState = {};

/**
 * 同意のフォーム。
 *
 * ⚠️ **チェックを既定で入れない。** 入れておくと、読まずに進めてしまう。
 * 同意は「押した」ではなく「選んだ」でなければ記録の意味が薄い。
 *
 * ⚠️ **プライバシーポリシーを同じチェックへ束ねない。** リンクで示すに
 * とどめる。束ねると、必要な同意が取れていないのに取れたつもりになる。
 */
export function ConsentForm({
  versionId,
  next,
}: {
  readonly versionId: string;
  readonly next: string;
}) {
  const [state, action, pending] = useActionState(recordConsentAction, INITIAL);

  return (
    <form className="sengoku-form" action={action}>
      <input type="hidden" name="versionId" value={versionId} />
      <input type="hidden" name="next" value={next} />
      {state.error === undefined ? null : <Notice tone="alert" title={state.error} />}

      <p className="sengoku-form__hint">
        {LEGAL_COPY.consentPrivacyNote}{' '}
        <a href="/legal/privacy" target="_blank" rel="noreferrer">
          {LEGAL_COPY.consentPrivacyLink}
        </a>
      </p>

      <label className="sengoku-checkbox">
        <input type="checkbox" name="agreed" />
        <span>{LEGAL_COPY.consentCheckbox}</span>
      </label>

      <button className="sengoku-button" type="submit" disabled={pending}>
        {pending ? '記録しています…' : LEGAL_COPY.consentSubmit}
      </button>
    </form>
  );
}
