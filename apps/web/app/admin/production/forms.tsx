'use client';

import { useActionState } from 'react';
import { Notice } from '@sengoku/ui';
import { PRODUCTION_COPY } from '../../../src/production-copy';
import { mailCheckAction, recordAttestationAction } from './actions';
import type { AdminActionState } from '../actions';

const INITIAL: AdminActionState = {};

/**
 * 証跡を残す。
 *
 * ⚠️ **消せないことを、押す前に伝える。** 押してから「取り消せません」と
 * 出すのでは遅い。
 *
 * ⚠️ **「不成立」も同じ重さで置く。** 成立だけを押しやすくすると、
 * 通らなかったことが記録されなくなる。
 */
export function AttestationForm({
  kind,
  title,
  hint,
}: {
  readonly kind: string;
  readonly title: string;
  readonly hint: string;
}) {
  const [state, action, pending] = useActionState(recordAttestationAction, INITIAL);
  return (
    <form className="sengoku-form" action={action}>
      <h3>{title}</h3>
      <p className="sengoku-form__hint">{hint}</p>
      {state.error === undefined ? null : <Notice tone="alert" title={state.error} />}
      {state.notice === undefined ? null : (
        <Notice tone="info" title={state.notice} hint={state.noticeHint ?? ''} />
      )}

      <input type="hidden" name="kind" value={kind} />

      <div className="sengoku-form__field">
        <span className="sengoku-form__label">結果</span>
        <label className="sengoku-radio">
          <input type="radio" name="succeeded" value="true" defaultChecked />
          <span>成立（確かめました）</span>
        </label>
        <label className="sengoku-radio">
          <input type="radio" name="succeeded" value="false" />
          <span>不成立（通りませんでした）</span>
        </label>
      </div>

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor={`note-${kind}`}>
          覚え書き
        </label>
        {/* ⚠️ 「不成立」には必ず要る。API が断る。 */}
        <p className="sengoku-form__hint">
          「不成立」のときは必ずお書きください。{PRODUCTION_COPY.noteWarning}
        </p>
        <textarea className="sengoku-form__input" id={`note-${kind}`} name="note" rows={3} />
      </div>

      <div className="sengoku-actions">
        <button className="sengoku-button sengoku-button--danger" type="submit" disabled={pending}>
          {pending ? '記録しています…' : 'この内容で記録する（取り消せません）'}
        </button>
      </div>
    </form>
  );
}

/** メールの試し送り。⚠️ 宛先は押した本人の業務用アドレス。 */
export function MailCheckForm() {
  const [state, action, pending] = useActionState(mailCheckAction, INITIAL);
  return (
    <form className="sengoku-inline-form" action={action}>
      {state.error === undefined ? null : <Notice tone="alert" title={state.error} />}
      {state.notice === undefined ? null : (
        <Notice tone="info" title={state.notice} hint={state.noticeHint ?? ''} />
      )}
      <button className="sengoku-button" type="submit" disabled={pending}>
        {pending ? '送っています…' : 'ご自分あてに試し送りする'}
      </button>
    </form>
  );
}
