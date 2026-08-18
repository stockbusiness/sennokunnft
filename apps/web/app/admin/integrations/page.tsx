import { EmptyState, Notice, PageHeader, StatusBadge } from '@sengoku/ui';
import { fetchIntegrations } from '../../../src/admin-client';
import { ADMIN_COPY } from '../../../src/admin-copy';
import { INTEGRATION_COPY, integrationServiceLabel } from '../../../src/integration-copy';

/**
 * 外部サービスとの接続（管理画面・外部連携 指示書 §4・§11）。
 *
 * ⚠️ **どの環境を触っているかを、いちばん先に出す。** 同じ画面で
 * staging と production を扱うため、どちらか分からないまま変更するのが
 * いちばん危ない。
 */
export default async function AdminIntegrationsPage() {
  const result = await fetchIntegrations();

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
      </>
    );
  }

  const { appEnvironment, items } = result.data;
  const isProduction = appEnvironment === 'production';

  return (
    <>
      <PageHeader title={INTEGRATION_COPY.title} description={INTEGRATION_COPY.description} />

      <Notice
        tone={isProduction ? 'alert' : 'info'}
        title={isProduction ? INTEGRATION_COPY.productionWarning : INTEGRATION_COPY.stagingNotice}
        hint={
          isProduction ? INTEGRATION_COPY.productionWarningHint : INTEGRATION_COPY.stagingNoticeHint
        }
      />

      <div className="sengoku-table-scroll">
        <table className="sengoku-table">
          <thead>
            <tr>
              <th scope="col">提携先</th>
              <th scope="col">状態</th>
              <th scope="col">設定の場所</th>
              <th scope="col">接続先</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.service}>
                <td>
                  {/*
                    ⚠️ ここは折り返してよい。名前が長いので、折り返さないと
                       いちばん見たい「状態」が画面の外へ押し出される。
                  */}
                  <a href={`/admin/integrations/${encodeURIComponent(item.service)}`}>
                    {integrationServiceLabel(item.service)}
                  </a>
                </td>
                <td className="sengoku-table__nowrap">
                  {/*
                    ⚠️ **管理外の連携で「有効／停止中」と書かない。**
                       あちらに開始・停止の概念は無い。あるのは
                       「設定がそろっているか」だけ。同じ言葉にすると、
                       止められると思われる。
                  */}
                  <StatusBadge
                    label={
                      item.manageable
                        ? item.enabled
                          ? '有効'
                          : '停止中'
                        : item.enabled
                          ? '設定済み'
                          : '設定が足りません'
                    }
                    tone={item.enabled ? 'success' : item.manageable ? 'neutral' : 'warning'}
                  />
                </td>
                <td className="sengoku-table__nowrap">
                  {item.manageable ? 'この画面' : '配備環境'}
                </td>
                <td className="sengoku-code-inline">
                  {item.endpointUrl ?? INTEGRATION_COPY.notConfigured}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
