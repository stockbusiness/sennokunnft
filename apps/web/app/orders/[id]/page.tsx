import { notFound } from 'next/navigation';
import { EmptyState, Notice, PageHeader, PriceTag } from '@sengoku/ui';
import { fetchOrder } from '../../../src/order-client';
import { ORDER_COPY, formatDateTime, orderStatusLabel } from '../../../src/order-copy';

/**
 * 「決済準備中」の画面（指示書 §8）。
 *
 * ⚠️ **ここから外部の決済画面へ飛ばさない。** Phase P2 でつなぐ場所を
 * 空けてあるだけ。飛ばす先が無いのに「お支払いへ進む」を置くと、
 * 押しても何も起きないボタンになる。
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
  const expired = order.status === 'expired' || order.status === 'cancelled';

  return (
    <>
      <PageHeader
        title={ORDER_COPY.pendingTitle}
        description={expired ? undefined : ORDER_COPY.pendingDescription}
      />

      {expired ? (
        <Notice tone="alert" title={ORDER_COPY.expiredTitle} hint={ORDER_COPY.expiredHint} />
      ) : (
        /*
          ⚠️ **「準備中」であることをはっきり書く。** 何も出さないと、
             支払いが済んだと思って待たれる。何を待っているのかを言う。
        */
        <Notice
          tone="info"
          title={ORDER_COPY.pendingPreparingTitle}
          hint={ORDER_COPY.pendingPreparingHint}
        />
      )}

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
          </>
        )}
        <dt>{ORDER_COPY.checkoutPriceLabel}</dt>
        <dd>
          <PriceTag price={{ amount: order.totalAmount, currency: order.currency }} />
        </dd>
        <dt>{ORDER_COPY.columnOrderStatus}</dt>
        <dd>{orderStatusLabel(order.status)}</dd>
        {expired ? null : (
          <>
            <dt>{ORDER_COPY.reservedUntilLabel}</dt>
            <dd>{formatDateTime(order.reservationExpiresAt)}</dd>
          </>
        )}
        <dt>{ORDER_COPY.orderedAtLabel}</dt>
        <dd>{formatDateTime(order.createdAt)}</dd>
      </dl>

      <p className="sengoku-back-link">
        <a href="/">← {ORDER_COPY.backToCatalog}</a>
      </p>
    </>
  );
}
