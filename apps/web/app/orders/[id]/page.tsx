import { notFound } from 'next/navigation';
import { EmptyState, Notice, PageHeader, PriceTag } from '@sengoku/ui';
import { fetchOrder } from '../../../src/order-client';
import {
  ORDER_COPY,
  formatDateTime,
  orderStatusLabel,
  payFailureHint,
} from '../../../src/order-copy';
import { PayButton, PaymentResultPoller } from './forms';

/**
 * 注文の状態と、お支払いへの導線（指示書 §12）。
 *
 * ⚠️ **ブラウザが戻ってきたことを決済完了の根拠にしない**（指示書 §4-3）。
 * ここが読むのはサーバーの状態だけで、URL の中身は一切見ない。
 *
 * ⚠️ **静的化させない。** 状態は決済の進み方で変わる。
 */
export const dynamic = 'force-dynamic';

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await fetchOrder(id);

  if (!result.ok) {
    if (result.reason === 'not_found') {
      // 他人の注文もここに来る。存在の有無を区別しない。
      notFound();
    }
    if (result.reason === 'unauthenticated') {
      return (
        <>
          <PageHeader title={ORDER_COPY.pendingTitle} />
          <Notice
            tone="info"
            title={ORDER_COPY.loginRequiredTitle}
            hint={ORDER_COPY.loginRequiredHint}
          />
          <p className="sengoku-back-link">
            <a className="sengoku-button" href="/login">
              {ORDER_COPY.loginLink}
            </a>
          </p>
        </>
      );
    }
    return (
      <>
        <PageHeader title={ORDER_COPY.pendingTitle} />
        <EmptyState title={ORDER_COPY.retryTitle} hint={ORDER_COPY.retryHint} />
      </>
    );
  }

  const order = result.data;
  const closed = order.status === 'expired' || order.status === 'cancelled';
  const paid = order.status === 'paid';
  /*
    お支払いの手続き中に戻ってきた状態。
    ⚠️ **ここを「完了」と読ませない。** 決済会社からの通知が届くまで、
       払えたかどうかは分からない。
  */
  const awaitingResult =
    !paid && !closed && order.status === 'checkout_created' && order.paymentStatus === 'pending';
  const failed = order.paymentStatus === 'failed';
  const canPay = !paid && !closed && !awaitingResult;

  return (
    <>
      <PageHeader
        title={headingFor(order.status, paid)}
        description={paid ? ORDER_COPY.paidDescription : undefined}
      />

      {closed ? (
        <Notice tone="alert" title={ORDER_COPY.payExpiredTitle} hint={ORDER_COPY.payExpiredHint} />
      ) : null}

      {paid ? (
        /*
          ⚠️ **「作品を受け取りました」と書かない**（指示書 §12）。
             受取権はまだ発行していない（Phase P3）。
        */
        <Notice tone="info" title={ORDER_COPY.paidTitle} hint={ORDER_COPY.paidDescription} />
      ) : null}

      {awaitingResult ? <PaymentResultPoller /> : null}

      {failed && !closed ? (
        <Notice
          tone="alert"
          title={ORDER_COPY.payFailedTitle}
          // ⚠️ 拒否の理由を出さない。次の行動だけを示す。
          hint={payFailureHint(false)}
        />
      ) : null}

      <dl className="sengoku-facts">
        <dt>{ORDER_COPY.orderNumberLabel}</dt>
        <dd>
          <span className="sengoku-code-inline">{order.orderNumber}</span>
          <span className="sengoku-facts__hint">{ORDER_COPY.orderNumberHint}</span>
        </dd>
        {order.item === null ? null : (
          <>
            <dt>{ORDER_COPY.checkoutItemHeading}</dt>
            <dd>{order.item.titleSnapshot}</dd>
            {/*
              ⚠️ **注文時点のお名前を出す。** マスタを引き直さない。
                 出品者が改名しても、お買い上げの記録は動かさない。
              ⚠️ 未登録の方から買った注文は行ごと出さない。
            */}
            {order.item.creatorNameSnapshot === null ? null : (
              <>
                <dt>{ORDER_COPY.creatorNameLabel}</dt>
                <dd>{order.item.creatorNameSnapshot}</dd>
              </>
            )}
          </>
        )}
        <dt>{ORDER_COPY.checkoutPriceLabel}</dt>
        <dd>
          <PriceTag price={{ amount: order.totalAmount, currency: order.currency }} />
        </dd>
        <dt>{ORDER_COPY.columnOrderStatus}</dt>
        <dd>{orderStatusLabel(order.status)}</dd>
        {closed || paid ? null : (
          <>
            <dt>{ORDER_COPY.reservedUntilLabel}</dt>
            <dd>{formatDateTime(order.reservationExpiresAt)}</dd>
          </>
        )}
        <dt>{ORDER_COPY.orderedAtLabel}</dt>
        <dd>{formatDateTime(order.createdAt)}</dd>
      </dl>

      {canPay ? (
        <PayButton orderId={order.id} reused={order.status === 'checkout_created'} />
      ) : null}

      <p className="sengoku-back-link">
        <a href="/">← {ORDER_COPY.backToCatalog}</a>
      </p>
    </>
  );
}

function headingFor(status: string, paid: boolean): string {
  if (paid) return ORDER_COPY.paidTitle;
  if (status === 'expired' || status === 'cancelled') return ORDER_COPY.payExpiredTitle;
  return ORDER_COPY.pendingTitle;
}
