import { notFound } from 'next/navigation';
import { EmptyState, Notice, PageHeader, PriceTag, StatusBadge } from '@sengoku/ui';
import { fetchAdminOrder } from '../../../../src/admin-client';
import { ADMIN_COPY } from '../../../../src/admin-copy';
import {
  ORDER_COPY,
  formatDateTime,
  formatFeeRate,
  fulfillmentStatusLabel,
  orderStatusLabel,
  orderStatusTone,
  paymentStatusLabel,
  refundStatusLabel,
  reservationStatusLabel,
  attemptStatusLabel,
  webhookStatusLabel,
} from '../../../../src/order-copy';

/**
 * 注文の詳細（指示書 §9.2）。
 *
 * ⚠️ **状態を変える操作を置かない**（指示書 §9.3）。ここは記録を読む場所。
 * ⚠️ **重複防止キーは先頭だけを出す。** 全体を出しても運用の役に立たない。
 */
export default async function AdminOrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const result = await fetchAdminOrder(id);

  if (!result.ok) {
    if (result.reason === 'not_found') {
      notFound();
    }
    return (
      <>
        <PageHeader title={ORDER_COPY.detailHeading} />
        <EmptyState
          title={ADMIN_COPY.unavailableTitle(result.reason)}
          hint={ADMIN_COPY.unavailableHint}
        />
      </>
    );
  }

  const order = result.data;
  const currency = order.currency;

  return (
    <>
      <PageHeader title={order.orderNumber} description={ORDER_COPY.detailHeading} />

      <Notice
        tone="info"
        title={ORDER_COPY.adminReadOnlyTitle}
        hint={ORDER_COPY.adminReadOnlyHint}
      />

      <dl className="sengoku-facts">
        <dt>{ORDER_COPY.columnOrderStatus}</dt>
        <dd>
          <StatusBadge
            label={orderStatusLabel(order.status)}
            tone={orderStatusTone(order.status)}
          />
        </dd>
        <dt>{ORDER_COPY.columnPaymentStatus}</dt>
        <dd>{paymentStatusLabel(order.paymentStatus)}</dd>
        <dt>{ORDER_COPY.columnFulfillmentStatus}</dt>
        <dd>{fulfillmentStatusLabel(order.fulfillmentStatus)}</dd>
        <dt>返金</dt>
        <dd>{refundStatusLabel(order.refundStatus)}</dd>
        <dt>{ORDER_COPY.columnOrderedAt}</dt>
        <dd>{formatDateTime(order.createdAt)}</dd>
        <dt>お支払い日時</dt>
        <dd>{formatDateTime(order.paidAt)}</dd>
      </dl>

      <h2>{ORDER_COPY.checkoutItemHeading}</h2>
      {order.item === null ? (
        <EmptyState title="明細がありません" hint="" />
      ) : (
        <dl className="sengoku-facts">
          <dt>作品</dt>
          {/* ⚠️ 注文時点の名前。マスタを引き直して表示しない。 */}
          <dd>{order.item.titleSnapshot}</dd>
          <dt>単価</dt>
          <dd>
            <PriceTag
              price={{ amount: order.item.unitPriceAmount, currency: order.item.currency }}
            />
          </dd>
          <dt>{ORDER_COPY.checkoutQuantityLabel}</dt>
          <dd>{order.item.quantity}点</dd>
          <dt>{ORDER_COPY.columnCreator}</dt>
          <dd className="sengoku-code-inline">{order.creatorAccountId}</dd>
        </dl>
      )}

      <h2>{ORDER_COPY.detailAmountsHeading}</h2>
      <dl className="sengoku-facts">
        <dt>{ORDER_COPY.subtotalLabel}</dt>
        <dd>
          <PriceTag price={{ amount: order.subtotalAmount, currency }} />
        </dd>
        <dt>{ORDER_COPY.discountLabel}</dt>
        {/* ⚠️ 値引・手数料・配分は購入者が払う額ではない。「（税込）」を付けない。 */}
        <dd>
          <PriceTag price={{ amount: order.discountAmount, currency }} taxIncluded={false} />
        </dd>
        <dt>{ORDER_COPY.totalLabel}</dt>
        <dd>
          <PriceTag price={{ amount: order.totalAmount, currency }} />
        </dd>
        <dt>{ORDER_COPY.feeRateLabel}</dt>
        <dd>
          {formatFeeRate(order.platformFeeRateBps)}
          {order.platformFeeRateBps === 0 ? (
            <span className="sengoku-facts__hint">{ORDER_COPY.feeRateUndecidedHint}</span>
          ) : null}
        </dd>
        <dt>{ORDER_COPY.platformFeeLabel}</dt>
        <dd>
          <PriceTag price={{ amount: order.platformFeeAmount, currency }} taxIncluded={false} />
        </dd>
        <dt>{ORDER_COPY.creatorAmountLabel}</dt>
        <dd>
          <PriceTag price={{ amount: order.creatorAmount, currency }} taxIncluded={false} />
        </dd>
      </dl>

      <h2>{ORDER_COPY.detailReservationHeading}</h2>
      {order.reservation === null ? (
        <EmptyState title={ORDER_COPY.reservationNone} hint="" />
      ) : (
        <dl className="sengoku-facts">
          <dt>状態</dt>
          <dd>{reservationStatusLabel(order.reservation.status)}</dd>
          <dt>{ORDER_COPY.checkoutQuantityLabel}</dt>
          <dd>{order.reservation.quantity}点</dd>
          <dt>{ORDER_COPY.columnReservedUntil}</dt>
          <dd>{formatDateTime(order.reservation.expiresAt)}</dd>
          <dt>確定した日時</dt>
          <dd>{formatDateTime(order.reservation.consumedAt)}</dd>
          <dt>解放した日時</dt>
          <dd>{formatDateTime(order.reservation.releasedAt)}</dd>
        </dl>
      )}

      <h2>{ORDER_COPY.detailRelatedHeading}</h2>
      <dl className="sengoku-facts">
        <dt>決済の記録</dt>
        {/* ⚠️ 決済会社側の識別子は出さない。有無だけで運用は足りる。 */}
        <dd>{order.hasPayment ? ORDER_COPY.paymentPresent : ORDER_COPY.paymentAbsent}</dd>
        <dt>{ORDER_COPY.entitlementCountLabel}</dt>
        <dd>{order.entitlementCount}件</dd>
        <dt>{ORDER_COPY.idempotencyLabel}</dt>
        <dd>
          <span className="sengoku-code-inline">{order.idempotencyKeyPrefix}…</span>
          <span className="sengoku-facts__hint">{ORDER_COPY.idempotencyHint}</span>
        </dd>
        <dt>{ORDER_COPY.columnBuyer}</dt>
        <dd className="sengoku-code-inline">{order.accountId}</dd>
      </dl>

      {order.payments === undefined ? null : (
        <>
          <h2>{ORDER_COPY.adminPaymentsHeading}</h2>
          {order.payments.attempts.length === 0 ? (
            <EmptyState title={ORDER_COPY.adminNoPayments} hint="" />
          ) : (
            /*
              ⚠️ **支払いページの URL を出さない。** これを持つ人は誰でも
                 その注文を支払える。運用に要るのは識別子まで。
            */
            <ul className="sengoku-order-list">
              {order.payments.attempts.map((attempt) => (
                <li className="sengoku-order-card" key={attempt.id}>
                  <div className="sengoku-order-card__head">
                    <span>{attemptStatusLabel(attempt.status)}</span>
                    <span className="sengoku-form__hint">{formatDateTime(attempt.createdAt)}</span>
                  </div>
                  <dl className="sengoku-facts sengoku-facts--compact">
                    <dt>{ORDER_COPY.columnAttemptAmount}</dt>
                    <dd>
                      <PriceTag price={{ amount: attempt.amount, currency: attempt.currency }} />
                    </dd>
                    <dt>{ORDER_COPY.columnSessionRef}</dt>
                    <dd className="sengoku-code-inline">{attempt.sessionRef ?? '—'}</dd>
                    <dt>{ORDER_COPY.columnPaymentRef}</dt>
                    <dd className="sengoku-code-inline">{attempt.paymentRef ?? '—'}</dd>
                    <dt>{ORDER_COPY.columnChargeRef}</dt>
                    <dd className="sengoku-code-inline">{attempt.chargeRef ?? '—'}</dd>
                    <dt>{ORDER_COPY.columnAttemptExpires}</dt>
                    <dd>{formatDateTime(attempt.expiresAt)}</dd>
                    {attempt.failureCode === null ? null : (
                      <>
                        <dt>{ORDER_COPY.columnFailureCode}</dt>
                        {/* ⚠️ 決済会社の符号ではなく、こちらで決めた安全な符号。 */}
                        <dd className="sengoku-code-inline">{attempt.failureCode}</dd>
                      </>
                    )}
                  </dl>
                </li>
              ))}
            </ul>
          )}

          <dl className="sengoku-facts">
            <dt>{ORDER_COPY.amountMatchesLabel}</dt>
            <dd>{amountMatchesLabel(order.payments.amountMatches)}</dd>
          </dl>

          <h2>{ORDER_COPY.adminWebhooksHeading}</h2>
          {order.payments.webhooks.length === 0 ? (
            <EmptyState title={ORDER_COPY.adminNoWebhooks} hint="" />
          ) : (
            /* ⚠️ 本文は保存していない。出せるものが無い（指示書 §13）。 */
            <ul className="sengoku-order-list">
              {order.payments.webhooks.map((receipt, index: number) => (
                <li className="sengoku-order-card" key={`${receipt.eventType}-${String(index)}`}>
                  <div className="sengoku-order-card__head">
                    <span className="sengoku-code-inline">{receipt.eventType}</span>
                    <span>{webhookStatusLabel(receipt.status)}</span>
                  </div>
                  <dl className="sengoku-facts sengoku-facts--compact">
                    <dt>{ORDER_COPY.columnReceivedAt}</dt>
                    <dd>{formatDateTime(receipt.receivedAt)}</dd>
                    <dt>{ORDER_COPY.columnAttemptCount}</dt>
                    <dd>{receipt.attemptCount}回</dd>
                    <dt>{ORDER_COPY.columnLivemode}</dt>
                    <dd>
                      {receipt.livemode === null
                        ? '—'
                        : receipt.livemode
                          ? ORDER_COPY.livemodeLive
                          : ORDER_COPY.livemodeTest}
                    </dd>
                    {receipt.lastErrorCode === null ? null : (
                      <>
                        <dt>{ORDER_COPY.columnFailureCode}</dt>
                        <dd className="sengoku-code-inline">{receipt.lastErrorCode}</dd>
                      </>
                    )}
                  </dl>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <p className="sengoku-back-link">
        <a href="/admin/orders">{ORDER_COPY.backToOrders}</a>
      </p>
    </>
  );
}

/** 金額の一致。⚠️ 受領がまだ無いときは「一致しない」と言わない。 */
function amountMatchesLabel(matches: boolean | null): string {
  if (matches === null) return ORDER_COPY.amountMatchesUnknown;
  return matches ? ORDER_COPY.amountMatchesYes : ORDER_COPY.amountMatchesNo;
}
