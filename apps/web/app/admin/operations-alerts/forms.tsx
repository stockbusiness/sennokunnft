'use client';

import { useActionState } from 'react';
import { Notice } from '@sengoku/ui';
import type { OperationsAlertSettingsView } from '@sengoku/contracts';
import { ALERT_COPY as COPY } from '../../../src/alert-copy';
import { saveOperationsAlertSettingsAction } from './actions';
import type { AdminActionState } from '../actions';

const INITIAL: AdminActionState = {};

/**
 * 知らせの宛先と条件（`UD-1102` の一部）。
 *
 * ⚠️ **受け口の URL を初期値に入れない。** 読み戻しにはホスト名しか無く、
 * 入れるとホスト名がそのまま保存されうる。**変えるときは貼り直していただく。**
 *
 * ⚠️ **お客さまのアドレスを入れる欄ではないことを、欄のすぐ上に書く。**
 */
export function AlertSettingsForm({
  settings,
}: {
  readonly settings: OperationsAlertSettingsView;
}) {
  const [state, action, pending] = useActionState(saveOperationsAlertSettingsAction, INITIAL);

  return (
    <form className="sengoku-form" action={action}>
      {state.error === undefined ? null : <Notice tone="alert" title={state.error} />}
      {state.notice === undefined ? null : <Notice tone="info" title={state.notice} />}

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="alert-enabled">
          <input
            id="alert-enabled"
            name="enabled"
            type="checkbox"
            defaultChecked={settings.enabled}
          />{' '}
          {COPY.enabledLabel}
        </label>
        <p className="sengoku-form__hint">{COPY.enabledHint}</p>
      </div>

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="alert-severity">
          {COPY.minSeverityLabel}
        </label>
        <select
          className="sengoku-form__input"
          id="alert-severity"
          name="minSeverity"
          defaultValue={settings.minSeverity}
        >
          <option value="critical">{COPY.minSeverityCritical}</option>
          <option value="warning">{COPY.minSeverityWarning}</option>
        </select>
        <p className="sengoku-form__hint">{COPY.minSeverityHint}</p>
      </div>

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="alert-repeat">
          {COPY.repeatLabel}（{COPY.repeatUnit}）
        </label>
        <input
          className="sengoku-form__input"
          id="alert-repeat"
          name="repeatAfterMinutes"
          type="number"
          inputMode="numeric"
          min={15}
          max={1440}
          defaultValue={settings.repeatAfterMinutes}
        />
        <p className="sengoku-form__hint">{COPY.repeatHint}</p>
      </div>

      {/* ⚠️ 欄のすぐ上に置く。下に置くと、入力し終えてから読まれる。 */}
      <Notice tone="alert" title={COPY.recipientsWarning} hint={COPY.recipientsWarningHint} />

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="alert-recipients">
          {COPY.recipientsLabel}
        </label>
        <textarea
          className="sengoku-form__input"
          id="alert-recipients"
          name="emailRecipients"
          rows={4}
          placeholder={COPY.recipientsPlaceholder}
          defaultValue={settings.emailRecipients.join('\n')}
        />
      </div>

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="alert-webhook">
          {COPY.webhookLabel}
        </label>
        <p>
          {settings.webhookHost === null
            ? COPY.webhookMissing
            : COPY.webhookRegistered(settings.webhookHost)}
        </p>
        {/*
          ⚠️ **初期値を入れない。** 読み戻しにはホスト名しか無く、入れると
             ホスト名がそのまま保存されうる。変えるときは貼り直していただく。
        */}
        <input
          className="sengoku-form__input"
          id="alert-webhook"
          name="webhookUrl"
          type="url"
          autoComplete="off"
          placeholder={COPY.webhookPlaceholder}
          disabled={!settings.webhookStorable}
        />
        <p className="sengoku-form__hint">{COPY.webhookHint}</p>
        <p className="sengoku-form__hint">{COPY.webhookClearHint}</p>
        {settings.webhookHost === null ? null : (
          <label className="sengoku-form__label" htmlFor="alert-webhook-clear">
            <input id="alert-webhook-clear" name="clearWebhook" type="checkbox" />{' '}
            {COPY.webhookClearLabel}
          </label>
        )}
      </div>

      <button className="sengoku-button" type="submit" disabled={pending}>
        {pending ? COPY.saving : COPY.submit}
      </button>
    </form>
  );
}
