import { EmptyState, Notice, PageHeader, StatusBadge } from '@sengoku/ui';
import { fetchEntitlement } from '../../../../src/admin-client';
import { ADMIN_COPY } from '../../../../src/admin-copy';
import {
  entitlementStatusLabel,
  formatJst,
  walletDeliveryLabel,
} from '../../../../src/operations-copy';
import { RedeliverForm, RetryIssuanceForm } from '../forms';

/**
 * 受取権 1 件の詳細（実運営 指示書 P0-6）。
 *
 * ⚠️ **お届けした本文を出さない。** API が返さない。何を送ったかは
 * 種別と時刻で足りる。本文には受け取りのための値が入っている。
 *
 * ⚠️ **押しても何も起きないボタンを置かない。** 取り消し済み・
 * お受け取り済みのものには、送り直すボタンを出さない。
 */
export default async function AdminEntitlementDetailPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}) {
  const { id } = await params;
  const result = await fetchEntitlement(id);

  if (!result.ok) {
    return (
      <>
        <PageHeader title="受取権" />
        <EmptyState
          title={ADMIN_COPY.unavailableTitle(result.reason)}
          hint={ADMIN_COPY.unavailableHint}
        />
      </>
    );
  }

  const item = result.data;
  /*
    ⚠️ **送り直せるかどうかの最終判定は API 側。** ここは事故を減らすための
       足切りにすぎない。画面に規則を持たせると、規則が 2 か所になる。
  */
  const redeliverable = item.status === 'claimed' && item.walletDeliveryStatus !== 'delivered';

  return (
    <>
      <PageHeader
        title={`${item.artworkTitle} 第 ${String(item.serialNo)} 番`}
        description={`ご注文 ${item.orderNumber}`}
      />

      <dl className="sengoku-definition-list">
        <div>
          <dt>受取権の状態</dt>
          <dd>
            <StatusBadge label={entitlementStatusLabel(item.status)} />
          </dd>
        </div>
        <div>
          <dt>ウォレットへのお届け</dt>
          <dd>
            <StatusBadge label={walletDeliveryLabel(item.walletDeliveryStatus)} />
          </dd>
        </div>
        <div>
          <dt>お受け取り</dt>
          <dd>{formatJst(item.claimedAt)}</dd>
        </div>
        <div>
          <dt>お届け</dt>
          <dd>{formatJst(item.walletDeliveredAt)}</dd>
        </div>
        <div>
          <dt>作成</dt>
          <dd>{formatJst(item.createdAt)}</dd>
        </div>
        <div>
          <dt>ご注文</dt>
          <dd>
            <a href={`/admin/orders/${encodeURIComponent(item.orderId)}`}>{item.orderNumber}</a>
          </dd>
        </div>
      </dl>

      <h2>手当て</h2>
      <Notice
        tone="info"
        title="やり直しても、同じものが二重に作られることはありません。"
        hint="足りないぶん・届いていないぶんだけを扱います。"
      />
      <RetryIssuanceForm orderId={item.orderId} />
      {redeliverable ? (
        <RedeliverForm accountId={item.accountId} />
      ) : (
        <p className="sengoku-form__hint">
          {item.status === 'claimed'
            ? 'このぶんのお届けは済んでいます。'
            : 'まだお受け取りいただいていないため、お届けはできません。'}
        </p>
      )}

      <h2>お届けの記録</h2>
      {/*
        ⚠️ **本文は出さない。** 「見えるようにしてほしい」と言われたときに、
           理由ごと思い出せるよう、画面にも書いておく。
      */}
      <p className="sengoku-form__hint">
        お送りした本文はお見せしていません。本文には、お受け取りのための値が含まれます。
      </p>
      {item.deliveries.length === 0 ? (
        <EmptyState title="お届けの記録はまだありません。" />
      ) : (
        <div className="sengoku-table-scroll">
          <table className="sengoku-table sengoku-table--wide">
            <thead>
              <tr>
                <th scope="col">状態</th>
                <th scope="col">種別</th>
                <th scope="col">試した回数</th>
                <th scope="col">理由</th>
                <th scope="col">お届け</th>
              </tr>
            </thead>
            <tbody>
              {item.deliveries.map((delivery) => (
                <tr key={delivery.id}>
                  <td>
                    <StatusBadge label={delivery.status} />
                  </td>
                  <td className="sengoku-table__nowrap">{delivery.eventType}</td>
                  <td className="sengoku-table__nowrap">{String(delivery.attemptCount)} 回</td>
                  <td className="sengoku-table__nowrap">{delivery.lastErrorCode ?? '—'}</td>
                  <td className="sengoku-table__nowrap">{formatJst(delivery.deliveredAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p>
        <a className="sengoku-button sengoku-button--quiet" href="/admin/entitlements">
          一覧へ戻る
        </a>
      </p>
    </>
  );
}
