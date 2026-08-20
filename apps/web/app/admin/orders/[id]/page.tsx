import { notFound } from 'next/navigation';
import { EmptyState, Notice, PageHeader, PriceTag, StatusBadge } from '@sengoku/ui';
import {
  fetchAdminOrder,
  fetchAdminOrderNotes,
  fetchAdminOrderRefunds,
  fetchAdminOrderTimeline,
} from '../../../../src/admin-client';
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
  timelineKindLabel,
  timelineDetailText,
  shortId,
  REFUND_COPY,
  refundRecordStatusLabel,
  refundReasonLabel,
} from '../../../../src/order-copy';
import { OrderNoteForm } from './note-form';
import { RefundForm } from './refund-form';

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
  /*
    ⚠️ 3 本まとめて引く。順番に待つと、詳細が出るまでの待ち時間が
       そのぶん伸びる。どれか 1 本が落ちても、残りは出す。
  */
  const [result, timeline, notes, refunds] = await Promise.all([
    fetchAdminOrder(id),
    fetchAdminOrderTimeline(id),
    fetchAdminOrderNotes(id),
    fetchAdminOrderRefunds(id),
  ]);

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
          <dt>{ORDER_COPY.creatorNameLabel}</dt>
          {/*
            ⚠️ **注文時点のお名前。** いま改名されていても、この注文は
               当時の表示のまま残る。問い合わせの照合はこちらを見る。
          */}
          <dd>{order.item.creatorNameSnapshot ?? '—'}</dd>
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

      {/*
        経過（`UD-121`）。決済の試行と受信記録を 1 列にしたもの。
        ⚠️ **古い順。** 一覧は新しい順だが、経過は「何が起きて次に何が
           起きたか」を読むもので、逆順だと因果が逆に読める。
      */}
      <h2 className="sengoku-section-heading">{ORDER_COPY.timelineHeading}</h2>
      <p className="sengoku-form__hint">{ORDER_COPY.timelineHint}</p>
      {!timeline.ok || timeline.data.entries.length === 0 ? (
        <EmptyState title={ORDER_COPY.timelineEmpty} hint="" />
      ) : (
        <ol className="sengoku-timeline">
          {timeline.data.entries.map((entry, index) => (
            <li
              className="sengoku-timeline__entry"
              key={`${entry.kind}-${entry.at}-${String(index)}`}
            >
              <p className="sengoku-timeline__at">{formatDateTime(entry.at)}</p>
              <p className="sengoku-timeline__kind">{timelineKindLabel(entry.kind)}</p>
              {/*
                ⚠️ **必ず文字として描く。** `dangerouslySetInnerHTML` を
                   使わない。対応メモは運営の自由文で、`<` を含む文が
                   普通に入ってくる（ドメイン側で HTML を弾いていない）。
              */}
              {entry.kind === 'support_note' ? (
                <p className="sengoku-timeline__detail">{String(entry.detail.body ?? '')}</p>
              ) : (
                <p className="sengoku-timeline__detail">{timelineDetailText(entry)}</p>
              )}
            </li>
          ))}
        </ol>
      )}

      {/* 対応メモ（`UD-121`）。⚠️ 追記のみ。直す口も消す口も無い。 */}
      <h2 className="sengoku-section-heading">{ORDER_COPY.notesHeading}</h2>
      {!notes.ok || notes.data.notes.length === 0 ? (
        <EmptyState title={ORDER_COPY.notesEmpty} hint="" />
      ) : (
        <ul className="sengoku-note-list">
          {notes.data.notes.map((note) => (
            <li className="sengoku-note" key={note.id}>
              <p className="sengoku-note__meta">
                {formatDateTime(note.createdAt)} ／ {ORDER_COPY.notesAuthorLabel}:{' '}
                <span className="sengoku-code-inline">{shortId(note.authorAccountId)}</span>
              </p>
              {/* ⚠️ 文字として描く。HTML として解釈しない。 */}
              <p className="sengoku-note__body">{note.body}</p>
            </li>
          ))}
        </ul>
      )}
      <OrderNoteForm orderId={id} />

      <section>
        <h2>{REFUND_COPY.heading}</h2>
        {!refunds.ok ? (
          <p>{ADMIN_COPY.unavailableHint}</p>
        ) : refunds.data.items.length === 0 ? (
          <p>{REFUND_COPY.listEmpty}</p>
        ) : (
          <ul className="sengoku-order-list">
            {refunds.data.items.map((row) => (
              <li className="sengoku-order-card" key={row.id}>
                <div className="sengoku-order-card__head">
                  <PriceTag price={{ amount: row.amount, currency: row.currency }} />{' '}
                  <StatusBadge
                    tone={
                      row.status === 'succeeded'
                        ? 'success'
                        : row.status === 'failed'
                          ? 'warning'
                          : 'neutral'
                    }
                    label={refundRecordStatusLabel(row.status)}
                  />
                </div>
                <dl className="sengoku-facts">
                  <dt>{REFUND_COPY.reasonLabel}</dt>
                  <dd>{refundReasonLabel(row.reason)}</dd>
                  <dt>経路</dt>
                  <dd>
                    {row.initiatedBy === 'provider'
                      ? REFUND_COPY.initiatedByProvider
                      : REFUND_COPY.initiatedByAdmin}
                    {/*
                      ⚠️ **氏名やメールは出せない**（`UD-503`）。
                         見分けが付くのはアカウントIDの先頭までで、
                         それで足りる。
                    */}
                    {row.actorAccountId === null ? '' : ` ／ ${shortId(row.actorAccountId)}`}
                  </dd>
                  <dt>日時</dt>
                  <dd>{formatDateTime(row.settledAt ?? row.createdAt)}</dd>
                  {row.note === null ? null : (
                    <>
                      <dt>記録</dt>
                      {/* ⚠️ 文字として描く。HTML として解釈しない。 */}
                      <dd>{row.note}</dd>
                    </>
                  )}
                </dl>
              </li>
            ))}
          </ul>
        )}

        <RefundForm
          orderId={id}
          /*
            ⚠️ **隠すのは導線を分かりやすくするためで、保護ではない。**
               返してよいかの判定は API 側にある。ここでは「お支払いが
               済んでいて、まだ全額返していない」注文にだけ出す。
          */
          refundable={order.paymentStatus === 'succeeded' && order.refundStatus !== 'refunded'}
        />
      </section>

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
