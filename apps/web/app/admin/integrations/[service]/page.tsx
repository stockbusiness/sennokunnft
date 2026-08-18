import { EmptyState, Notice, PageHeader, StatusBadge } from '@sengoku/ui';
import { fetchIntegration } from '../../../../src/admin-client';
import { ADMIN_COPY } from '../../../../src/admin-copy';
import { formatDateTime } from '../../../../src/delivery-copy';
import {
  INTEGRATION_COPY,
  checkDetailLabel,
  integrationServiceLabel,
  secretPurposeLabel,
  secretStatusLabel,
} from '../../../../src/integration-copy';
import { CheckButton, EnableButton, SecretActionButton, SecretForm, SettingsForm } from '../forms';

/**
 * 提携先ごとの設定（管理画面・外部連携 指示書 §4・§6・§9・§11）。
 *
 * ⚠️ **登録済みの鍵をこの画面に出さない。** 出せる経路が API に無い。
 * 見分けが要るときのために、末尾 4 文字だけを出す。
 *
 * ⚠️ **確かめていないことを、確かめた顔で書かない。** いまの確認は
 * 接続先へ届くかどうかまでで、鍵が正しいかどうかは分からない（要決定 06）。
 */
export default async function AdminIntegrationPage({
  params,
}: {
  readonly params: Promise<{ readonly service: string }>;
}) {
  const { service } = await params;
  const result = await fetchIntegration(service);

  if (!result.ok) {
    return (
      <>
        <PageHeader title={INTEGRATION_COPY.title} />
        <EmptyState
          title={ADMIN_COPY.unavailableTitle(result.reason)}
          hint={
            result.reason === 'unauthorized'
              ? '外部サービスとの接続を扱えるのはオーナーだけです。'
              : ADMIN_COPY.unavailableHint
          }
        />
        <p>
          <a href="/admin/integrations">一覧へ戻る</a>
        </p>
      </>
    );
  }

  const status = result.data;
  const isProduction = status.environment === 'production';

  return (
    <>
      <PageHeader title={integrationServiceLabel(status.service)} />

      {/* ⚠️ 本番かどうかを、いちばん先に出す。 */}
      <Notice
        tone={isProduction ? 'alert' : 'info'}
        title={isProduction ? INTEGRATION_COPY.productionWarning : INTEGRATION_COPY.stagingNotice}
        hint={
          isProduction ? INTEGRATION_COPY.productionWarningHint : INTEGRATION_COPY.stagingNoticeHint
        }
      />

      <h2>{INTEGRATION_COPY.statusHeading}</h2>
      <p>
        <StatusBadge
          label={status.enabled ? INTEGRATION_COPY.statusEnabled : INTEGRATION_COPY.statusDisabled}
          tone={status.enabled ? 'success' : 'neutral'}
        />
      </p>
      <dl className="sengoku-definition-list">
        <div>
          <dt>{INTEGRATION_COPY.statusEndpoint}</dt>
          <dd className="sengoku-code-inline">
            {status.endpointUrl ?? INTEGRATION_COPY.notConfigured}
          </dd>
        </div>
        <div>
          <dt>{INTEGRATION_COPY.statusKeyId}</dt>
          <dd className="sengoku-code-inline">{status.keyId ?? INTEGRATION_COPY.notConfigured}</dd>
        </div>
        <div>
          <dt>{INTEGRATION_COPY.statusTimeout}</dt>
          <dd>{String(status.timeoutMs)} ミリ秒</dd>
        </div>
        <div>
          <dt>{INTEGRATION_COPY.statusMaxAttempts}</dt>
          <dd>{String(status.maxAttempts)} 回</dd>
        </div>
      </dl>

      <h2>{INTEGRATION_COPY.enableHeading}</h2>
      <EnableButton
        service={status.service}
        enabled={status.enabled}
        canEnable={status.canEnable}
      />

      <h2>{INTEGRATION_COPY.checkHeading}</h2>
      <p>{INTEGRATION_COPY.checkIntro}</p>
      {/*
        ⚠️ **何を確かめていないかを、必ず併記する。**
           「テスト成功」だけを出すと、鍵まで確かめた気にさせる。
      */}
      <Notice
        tone="info"
        title={INTEGRATION_COPY.checkLimitation}
        hint={INTEGRATION_COPY.checkLimitationHint}
      />
      {status.canCheck ? (
        <CheckButton service={status.service} />
      ) : (
        <p className="sengoku-form__hint">{INTEGRATION_COPY.checkNeedsEndpoint}</p>
      )}

      <h3>{INTEGRATION_COPY.historyHeading}</h3>
      {status.recentChecks.length === 0 ? (
        <EmptyState title={INTEGRATION_COPY.noChecks} hint={INTEGRATION_COPY.noChecksHint} />
      ) : (
        <div className="sengoku-table-scroll">
          <table className="sengoku-table sengoku-table--wide">
            <thead>
              <tr>
                <th scope="col">{INTEGRATION_COPY.columnCheckedAt}</th>
                <th scope="col">{INTEGRATION_COPY.columnResult}</th>
                <th scope="col">{INTEGRATION_COPY.columnDetail}</th>
                <th scope="col">{INTEGRATION_COPY.columnDuration}</th>
              </tr>
            </thead>
            <tbody>
              {status.recentChecks.map((check) => (
                <tr key={check.id}>
                  <td className="sengoku-table__nowrap">{formatDateTime(check.executedAt)}</td>
                  <td className="sengoku-table__nowrap">
                    <StatusBadge
                      label={check.succeeded ? INTEGRATION_COPY.checkOk : INTEGRATION_COPY.checkNg}
                      tone={check.succeeded ? 'success' : 'warning'}
                    />
                  </td>
                  <td>{checkDetailLabel(check)}</td>
                  <td className="sengoku-table__nowrap">{String(check.durationMs)} ミリ秒</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>{INTEGRATION_COPY.settingsHeading}</h2>
      <SettingsForm status={status} />

      <h2>{INTEGRATION_COPY.secretHeading}</h2>
      <p>{INTEGRATION_COPY.secretIntro}</p>
      <SecretForm service={status.service} />

      <h3>{INTEGRATION_COPY.secretsHeading}</h3>
      {status.secrets.length === 0 ? (
        <EmptyState title={INTEGRATION_COPY.noSecrets} hint={INTEGRATION_COPY.noSecretsHint} />
      ) : (
        <div className="sengoku-table-scroll">
          <table className="sengoku-table sengoku-table--wide">
            <thead>
              <tr>
                <th scope="col">{INTEGRATION_COPY.columnPurpose}</th>
                <th scope="col">{INTEGRATION_COPY.columnLastFour}</th>
                <th scope="col">{INTEGRATION_COPY.columnSecretStatus}</th>
                <th scope="col">{INTEGRATION_COPY.columnKeyVersion}</th>
                <th scope="col">{INTEGRATION_COPY.columnActions}</th>
              </tr>
            </thead>
            <tbody>
              {status.secrets.map((secret) => (
                <tr key={secret.id}>
                  <td className="sengoku-table__nowrap">{secretPurposeLabel(secret.purpose)}</td>
                  {/* ⚠️ 出せるのはここまで。全文を返す経路は API に無い。 */}
                  <td className="sengoku-table__nowrap">
                    {secret.lastFour === '' ? '—' : `…${secret.lastFour}`}
                  </td>
                  <td className="sengoku-table__nowrap">{secretStatusLabel(secret.status)}</td>
                  <td className="sengoku-table__nowrap">{secret.keyVersion}</td>
                  <td>
                    {/* 待機中のものにだけ操作を出す。押せて何も起きないものを置かない。 */}
                    {secret.status === 'pending' ? (
                      <div className="sengoku-actions">
                        <SecretActionButton
                          service={status.service}
                          secretId={secret.id}
                          kind="activate"
                        />
                        <SecretActionButton
                          service={status.service}
                          secretId={secret.id}
                          kind="discard"
                        />
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p>
        <a href="/admin/integrations">一覧へ戻る</a>
      </p>
    </>
  );
}
