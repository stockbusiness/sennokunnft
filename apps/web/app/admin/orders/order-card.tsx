import type { AdminOrderView } from '@sengoku/contracts';
import { PriceTag, StatusBadge } from '@sengoku/ui';
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
 * 注文 1 件ぶんの札。
 *
 * ⚠️ **表にしていない。** 指示書が求める項目は 10 個あり、表にすると
 * 幅 48rem になる。スマホ（420px 幅）では横スクロールの中に半分が隠れ、
 * 金額が「￥12,00」で切れ、作品名が一文字ずつ縦に割れる。
 * 管理画面はスマホ操作を前提にする決まりなので、1 件 1 枚の札にしてある。
 *
 * ⚠️ **購入者を特定できる情報をここへ足さない**（`UD-121`・`UD-503`）。
 * 探せることと、並べて見えることは別。メールアドレスから辿ったときも
 * 同じ札を使うのは、辿り方によって見える量が変わらないようにするため。
 */
export function AdminOrderCard({ order }: { readonly order: AdminOrderView }) {
  return (
    <li className="sengoku-order-card">
      <div className="sengoku-order-card__head">
        <a className="sengoku-order-card__number" href={`/admin/orders/${order.id}`}>
          {order.orderNumber}
        </a>
        <StatusBadge label={orderStatusLabel(order.status)} tone={orderStatusTone(order.status)} />
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
  );
}
