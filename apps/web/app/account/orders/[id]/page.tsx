import { notFound } from 'next/navigation';
import { EmptyState, Notice, PageHeader, PriceTag, StatusBadge } from '@sengoku/ui';
import { fetchMyCollectibles, fetchOrder } from '../../../../src/order-client';
import { ACCOUNT_COPY, deliveryStateLabel, deliveryTone } from '../../../../src/account-copy';
import {
  ORDER_COPY,
  formatDateTime,
  orderStatusLabel,
  payFailureHint,
} from '../../../../src/order-copy';
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
  /*
    ⚠️ **お受け取りの状態も同時に読む**（指示書 §6）。注文だけを見せると、
       「払ったのに、いつ受け取れるのか」が分からないまま残る。
  */
  const [result, collectibles] = await Promise.all([fetchOrder(id), fetchMyCollectibles()]);

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
          ⚠️ **ここで「お受け取りが完了しました」と言い切らない。** お支払いが
             済んだことと、Wallet へ届いたことは別。届いたかどうかは下の
             「お受け取り」の欄が、実際の状態から答える。
        */
        <Notice tone="info" title={ORDER_COPY.paidTitle} hint={ORDER_COPY.paidDescription} />
      ) : null}

      {/*
        ご返金。⚠️ **金額を書かない。** 一部返金は自動処理しない決まりなので、
        画面に出した額と実際の額が食い違いうる。状態だけを伝える。
      */}
      {order.refundStatus === 'none' ? null : (
        <Notice
          title={refundNotice(order.refundStatus)}
          hint="ご返金の反映には、お支払い方法により数日かかることがあります。"
        />
      )}

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

      {/*
        お受け取りの状態（指示書 §6）。

        ⚠️ **お支払いが済むまで出さない。** まだ払っていない方に受け取りの話を
           すると、払わずに受け取れるように読める。
        ⚠️ **読めなかったときは黙る。** 「ありません」と書くと、あるものを
           無いと言ってしまう。
      */}
      {paid && collectibles.ok ? (
        <section className="sengoku-panel">
          <h2 className="sengoku-panel__title">{ACCOUNT_COPY.deliveryLabel}</h2>
          {(() => {
            const mine = collectibles.data.items.filter((item) => item.orderId === order.id);
            if (mine.length === 0) {
              return (
                <p className="sengoku-form__hint">
                  ただいま発行の準備をしています。しばらくお待ちください。
                </p>
              );
            }
            return (
              <ul className="sengoku-admin__list">
                {mine.map((item) => (
                  <li key={item.entitlementId}>
                    <StatusBadge
                      label={deliveryStateLabel(item.status)}
                      tone={deliveryTone(item.status)}
                    />{' '}
                    {item.artworkTitle}（{ACCOUNT_COPY.serialLabel} {item.serialNo}）
                  </li>
                ))}
              </ul>
            );
          })()}
          <p className="sengoku-back-link">
            <a href="/account/collectibles">{ACCOUNT_COPY.toCollectibles}</a>
          </p>
        </section>
      ) : null}

      <p className="sengoku-back-link">
        <a href="/account/orders">{ACCOUNT_COPY.toOrders}</a>
        {' ／ '}
        <a href="/">{ORDER_COPY.backToCatalog}</a>
      </p>
    </>
  );
}

/**
 * ご返金の状態を、買った方の言葉にする。
 *
 * ⚠️ **`failed` を「失敗しました」で終わらせない。** 買った方にできることは
 * 無く、運営が追う話である。「確認しています」と伝えて問い合わせへ送る。
 */
function refundNotice(status: string): string {
  switch (status) {
    case 'pending':
      return 'ご返金のお手続きを進めています';
    case 'partially_refunded':
      return '一部のご返金が済んでいます';
    case 'refunded':
      return 'ご返金が済んでいます';
    default:
      return 'ご返金について運営が確認しています';
  }
}

function headingFor(status: string, paid: boolean): string {
  if (paid) return ORDER_COPY.paidTitle;
  if (status === 'expired' || status === 'cancelled') return ORDER_COPY.payExpiredTitle;
  return ORDER_COPY.pendingTitle;
}
