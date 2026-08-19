import { EmptyState, Notice, PageHeader, PriceTag, StatusBadge } from '@sengoku/ui';
import { fetchAdminOrders } from '../../../src/admin-client';
import { ADMIN_COPY } from '../../../src/admin-copy';
import {
  ORDER_COPY,
  formatDateTime,
  fulfillmentStatusLabel,
  orderStatusLabel,
  orderStatusTone,
  paymentStatusLabel,
  shortId,
} from '../../../src/order-copy';

/**
 * 注文の一覧（指示書 §9.1）。
 *
 * ⚠️ **表にしていない。** 指示書が求める項目は 10 個あり、表にすると
 * 幅 48rem になる。スマホ（420px 幅）では横スクロールの中に半分が隠れ、
 * 金額が「￥12,00」で切れ、作品名が一文字ずつ縦に割れる。
 * 実際に画面を出して確かめたときにそうなった。
 * 管理画面はスマホ操作を前提にする決まりなので、1 件 1 枚の札にしてある。
 *
 * ⚠️ **読むだけの画面にしてある。** 金額の書換え・お支払い済みへの変更・
 * 削除は API 側に無い（指示書 §9.3）。画面にボタンだけ置くと、
 * 押しても動かない操作が残り、いつか「動くように直そう」と言われる。
 */
export default async function AdminOrdersPage() {
  const result = await fetchAdminOrders({ limit: 50 });

  if (!result.ok) {
    return (
      <>
        <PageHeader title={ORDER_COPY.adminTitle} />
        <EmptyState
          title={ADMIN_COPY.unavailableTitle(result.reason)}
          hint={ADMIN_COPY.unavailableHint}
        />
      </>
    );
  }

  const orders = result.data.items;

  return (
    <>
      <PageHeader title={ORDER_COPY.adminTitle} description={ORDER_COPY.adminDescription} />

      <Notice
        tone="info"
        title={ORDER_COPY.adminReadOnlyTitle}
        hint={ORDER_COPY.adminReadOnlyHint}
      />

      {orders.length === 0 ? (
        <EmptyState title={ORDER_COPY.adminNoOrders} hint={ORDER_COPY.adminNoOrdersHint} />
      ) : (
        <ul className="sengoku-order-list">
          {orders.map((order) => (
            <li className="sengoku-order-card" key={order.id}>
              <div className="sengoku-order-card__head">
                <a className="sengoku-order-card__number" href={`/admin/orders/${order.id}`}>
                  {order.orderNumber}
                </a>
                <StatusBadge
                  label={orderStatusLabel(order.status)}
                  tone={orderStatusTone(order.status)}
                />
              </div>

              <p className="sengoku-order-card__item">{order.item?.titleSnapshot ?? '—'}</p>

              <dl className="sengoku-facts sengoku-facts--compact">
                <dt>{ORDER_COPY.columnAmount}</dt>
                <dd>
                  <PriceTag price={{ amount: order.totalAmount, currency: order.currency }} />
                </dd>
                <dt>{ORDER_COPY.columnPaymentStatus}</dt>
                <dd>{paymentStatusLabel(order.paymentStatus)}</dd>
                <dt>{ORDER_COPY.columnFulfillmentStatus}</dt>
                <dd>{fulfillmentStatusLabel(order.fulfillmentStatus)}</dd>
                <dt>{ORDER_COPY.columnReservedUntil}</dt>
                <dd>{formatDateTime(order.reservationExpiresAt)}</dd>
                <dt>{ORDER_COPY.columnOrderedAt}</dt>
                <dd>{formatDateTime(order.createdAt)}</dd>
                {/*
                  ⚠️ 購入者と出品者は**先頭だけ**を出す。一覧で並べたいのは
                     「同じ人か」であって、識別子そのものではない。
                     全体が要るときは詳細を開く。
                */}
                <dt>{ORDER_COPY.columnBuyer}</dt>
                <dd className="sengoku-code-inline">{shortId(order.accountId)}</dd>
                <dt>{ORDER_COPY.columnCreator}</dt>
                <dd className="sengoku-code-inline">{shortId(order.creatorAccountId)}</dd>
              </dl>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
