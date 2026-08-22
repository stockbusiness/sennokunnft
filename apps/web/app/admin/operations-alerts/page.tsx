import { EmptyState, Notice, PageHeader } from '@sengoku/ui';
import { fetchOperationsAlertSettings } from '../../../src/admin-client';
import { ADMIN_COPY } from '../../../src/admin-copy';
import { ALERT_COPY as COPY, alertHasNoDestination } from '../../../src/alert-copy';
import { formatDateTime } from '../../../src/order-copy';
import { AlertSettingsForm } from './forms';

/**
 * 異常のお知らせ（`UD-1102` の一部）。
 *
 * ⚠️ **設定しただけで安心されないようにする。** 時計仕掛けが回っていなければ、
 * ここを設定してもお知らせは届かない。そのことを画面に書く。
 *
 * ⚠️ **受け口の URL はこの画面に出ない。** URL 自体が合言葉である。
 */
export default async function AdminOperationsAlertsPage() {
  const result = await fetchOperationsAlertSettings();

  if (!result.ok) {
    return (
      <>
        <PageHeader title={COPY.title} />
        <EmptyState
          title={ADMIN_COPY.unavailableTitle(result.reason)}
          hint={ADMIN_COPY.unavailableHint}
        />
      </>
    );
  }

  const settings = result.data.settings;

  return (
    <>
      <PageHeader title={COPY.title} description={COPY.description} />

      {/* ⚠️ 送る口が無ければ、いちばん上で断る。設定しても届かない。 */}
      {settings.deliverable ? null : (
        <Notice tone="alert" title={COPY.undeliverable} hint={COPY.undeliverableHint} />
      )}

      {settings.webhookStorable ? null : (
        <Notice tone="info" title={COPY.webhookUnstorable} hint={COPY.webhookUnstorableHint} />
      )}

      {/*
        ⚠️ **有効なのに宛先が無い状態を、画面が指摘する。** 指摘しないと、
           「設定した」と思ったまま誰にも届かない。
      */}
      {settings.enabled && alertHasNoDestination(settings) ? (
        <Notice
          tone="alert"
          title="送り先が 1 つも登録されていません"
          hint="このままではお知らせは届きません。下の欄に運営の業務用アドレスをご登録ください。"
        />
      ) : null}

      <Notice tone="info" title={COPY.needsClockNotice} hint={COPY.needsClockHint} />
      <Notice tone="info" title={COPY.suppressionNotice} hint={COPY.suppressionHint} />

      <dl className="sengoku-facts">
        <dt>{COPY.lastNotifiedLabel}</dt>
        <dd>
          {settings.lastNotifiedAt === null
            ? COPY.lastNotifiedNever
            : formatDateTime(settings.lastNotifiedAt)}
        </dd>
      </dl>

      <AlertSettingsForm settings={settings} />

      {/* ⚠️ 押せるのは誰かを、押す前に書く。 */}
      <p className="sengoku-form__hint">
        {COPY.ownerOnly} {COPY.ownerOnlyHint}
      </p>
    </>
  );
}
