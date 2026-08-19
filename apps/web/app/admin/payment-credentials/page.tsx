import { EmptyState, Notice, PageHeader, StatusBadge } from '@sengoku/ui';
import { fetchPaymentCredentials } from '../../../src/admin-client';
import { ADMIN_COPY } from '../../../src/admin-copy';
import { PAYMENT_CREDENTIAL_COPY as COPY } from '../../../src/payment-credential-copy';
import { CheckButton, CredentialActionForm, RegisterForm } from './forms';

/**
 * 決済の資格情報（`UD-118`）。
 *
 * ⚠️ **鍵を出さない。** 出すのは状態と事業者アカウント識別子まで。
 * 値・先頭・末尾 4 文字のいずれも出さない（2026-08-19 決定）。
 * OVEW Wallet では末尾を出しているが、決済では出さない。判断が分かれて
 * いるので取り違えないこと。
 *
 * ⚠️ **削除の操作を置かない。** API にも無い。消すと、その世代で処理した
 * 決済の返金経路が消える。
 */
export default async function PaymentCredentialsPage() {
  const result = await fetchPaymentCredentials();

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

  const { generations, canAcceptPayments, emergencyOverrideActive, environment } = result.data;
  const isProduction = environment === 'production';

  return (
    <>
      <PageHeader title={COPY.title} description={COPY.description} />

      {/*
        ⚠️ **いちばん先に出す。** 二重管理が黙って復活している状態が、
           いちばん気づきにくい。
      */}
      {emergencyOverrideActive ? (
        <Notice tone="alert" title={COPY.emergencyOverride} hint={COPY.emergencyOverrideHint} />
      ) : null}

      {canAcceptPayments ? null : (
        <Notice tone="alert" title={COPY.cannotAccept} hint={COPY.cannotAcceptHint} />
      )}

      <section>
        <h2>{COPY.listHeading}</h2>
        {generations.length === 0 ? (
          <p>{COPY.cannotAcceptHint}</p>
        ) : (
          <ul className="sengoku-order-list">
            {generations.map((row) => (
              <li className="sengoku-order-card" key={row.id}>
                <div className="sengoku-order-card__head">
                  <strong>第{row.generation}世代</strong>{' '}
                  <StatusBadge
                    tone={row.acceptsNewPayments ? 'success' : 'neutral'}
                    label={
                      row.status === 'retired'
                        ? COPY.statusRetired
                        : row.status === 'active'
                          ? COPY.statusActive
                          : COPY.statusPending
                    }
                  />{' '}
                  <span>{row.acceptsNewPayments ? COPY.accepting : COPY.notAccepting}</span>
                </div>

                <dl className="sengoku-facts">
                  <dt>{COPY.accountRef}</dt>
                  <dd>{row.accountRef ?? COPY.accountRefUnknown}</dd>
                  <dt>{COPY.lastCheck}</dt>
                  <dd>
                    {row.lastCheckSucceeded === null
                      ? COPY.lastCheckNever
                      : row.lastCheckSucceeded
                        ? COPY.lastCheckOk
                        : COPY.lastCheckFailed}
                    {row.lastCheckAt === null ? '' : ` — ${formatDateTime(row.lastCheckAt)}`}
                  </dd>
                  <dt>{COPY.lastWebhook}</dt>
                  <dd>{formatDateTime(row.lastWebhookReceivedAt)}</dd>
                  <dt>{COPY.paymentCount}</dt>
                  <dd>{row.paymentCount} 件</dd>
                  <dt>{COPY.verifiable}</dt>
                  <dd>{row.verifiable ? '対象' : COPY.notVerifiable}</dd>
                  {row.label === null ? null : (
                    <>
                      <dt>{COPY.fieldLabel}</dt>
                      <dd>{row.label}</dd>
                    </>
                  )}
                </dl>

                {/*
                  ⚠️ **押せるのに効かないボタンを出さない。** 受付中の世代に
                     「退役させる」を出すと、押してから断られる。
                */}
                {row.status === 'retired' ? null : <CheckButton id={row.id} />}

                {row.acceptsNewPayments || row.status === 'retired' ? null : (
                  <CredentialActionForm
                    id={row.id}
                    action="activate"
                    label={COPY.buttonActivate}
                    needsConfirmation={isProduction}
                    warning={COPY.activateWarning}
                  />
                )}

                {row.acceptsNewPayments ? (
                  <CredentialActionForm
                    id={row.id}
                    action="stop-accepting"
                    label={COPY.buttonStopAccepting}
                    needsConfirmation={isProduction}
                  />
                ) : null}

                {row.status === 'active' && !row.acceptsNewPayments ? (
                  <CredentialActionForm
                    id={row.id}
                    action="retire"
                    label={COPY.buttonRetire}
                    needsConfirmation={isProduction}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>{COPY.registerHeading}</h2>
        <RegisterForm />
      </section>
    </>
  );
}

function formatDateTime(value: string | null): string {
  if (value === null) {
    return '—';
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat('ja-JP', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'Asia/Tokyo',
      }).format(date);
}
