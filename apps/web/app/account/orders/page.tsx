import { EmptyState, Notice, PageHeader, PriceTag, StatusBadge } from '@sengoku/ui';
import { fetchMyOrders } from '../../../src/order-client';
import { ACCOUNT_COPY, paymentStateLabel } from '../../../src/account-copy';
import { formatDateTime } from '../../../src/order-copy';

/**
 * ご注文の履歴（P0-3）。
 *
 * ⚠️ **スマートフォンを第一に。** 表ではなく縦に積む札にする。狭い画面で
 * 横に伸びる表は、指で横へ動かさないと金額が見えない。
 */
export default async function AccountOrdersPage() {
  const result = await fetchMyOrders();

  if (!result.ok) {
    return (
      <>
        <PageHeader title={ACCOUNT_COPY.ordersTitle} />
        <Notice
          tone="alert"
          title={
            result.reason === 'unauthenticated'
              ? 'ログインが必要です'
              : 'ご注文の履歴を読み込めませんでした'
          }
          hint={
            result.reason === 'unauthenticated'
              ? 'ご登録のメールアドレスでログインのうえ、もう一度お試しください。'
              : 'しばらくしてから、もう一度お試しください。'
          }
        />
      </>
    );
  }

  return (
    <>
      <PageHeader title={ACCOUNT_COPY.ordersTitle} description={ACCOUNT_COPY.ordersDescription} />

      {result.data.items.length === 0 ? (
        <EmptyState title={ACCOUNT_COPY.noOrders} hint={ACCOUNT_COPY.noOrdersHint} />
      ) : (
        <ul className="sengoku-order-list">
          {result.data.items.map((order) => (
            <li key={order.id}>
              <article className="sengoku-order-card">
                <div className="sengoku-order-card__head">
                  <span className="sengoku-order-card__number">{order.orderNumber}</span>
                  {/* ⚠️ 色だけで区別しない。言葉で state を伝える。 */}
                  <StatusBadge
                    label={paymentStateLabel(order)}
                    tone={order.paymentStatus === 'succeeded' ? 'success' : 'progress'}
                  />
                </div>
                <p className="sengoku-order-card__item">{order.item?.titleSnapshot ?? '—'}</p>
                <dl className="sengoku-facts sengoku-facts--compact">
                  <dt>{ACCOUNT_COPY.orderedAtLabel}</dt>
                  <dd>{formatDateTime(order.createdAt)}</dd>
                  <dt>{ACCOUNT_COPY.amountLabel}</dt>
                  <dd>
                    <PriceTag price={{ amount: order.totalAmount, currency: order.currency }} />
                  </dd>
                </dl>
                <p className="sengoku-back-link">
                  <a href={`/account/orders/${order.id}`}>{ACCOUNT_COPY.detailLink}</a>
                </p>
              </article>
            </li>
          ))}
        </ul>
      )}

      <p className="sengoku-back-link">
        <a href="/account">{ACCOUNT_COPY.backToAccount}</a>
      </p>
    </>
  );
}
