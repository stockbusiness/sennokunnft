import { EmptyState, Notice, PageHeader, StatusBadge } from '@sengoku/ui';
import { fetchMyReceivables, fetchMyRefundInquiries } from '../../../src/creator-client';
import { creatorErrorMessage } from '../../../src/creator-copy';
import { formatJst, formatYen } from '../../../src/customer-copy';
import {
  REFUND_REQUEST_COPY as COPY,
  receivableStatusLabel,
  refundReasonLabel,
} from '../../../src/refund-request-copy';
import { AnswerInquiryForm } from './form';

/**
 * 作家さまへの事実確認と、売上からのお戻し（方針整理 2026-08-22）。
 *
 * ⚠️ **返金を実行する口はここに無い。** 作家さまにあるのは「事実確認に
 * 答えること」だけである。販売の代金は運営の決済アカウントで受けているので、
 * 返せるのも運営だけになる。
 *
 * ⚠️ **金額とご購入者さまを出さない。** 事実をお答えいただくのに要らない。
 * 出すと、いくら返るのかを作家さまが先に知ることになり、回答が歪む。
 *
 * ⚠️ **誰の分かを問い合わせで渡さない。** アカウントは API がトークンから
 * 決める。渡せる形にすると、そこが他人の分を覗く道になる。
 */
export default async function CreatorRefundInquiriesPage() {
  const [inquiries, receivables] = await Promise.all([
    fetchMyRefundInquiries(),
    fetchMyReceivables(),
  ]);

  return (
    <>
      <PageHeader title={COPY.creatorTitle} description={COPY.creatorDescription} />

      <section>
        {!inquiries.ok ? (
          <EmptyState title={creatorErrorMessage(inquiries.reason, inquiries.code)} />
        ) : inquiries.data.items.length === 0 ? (
          <Notice tone="info" title={COPY.creatorEmpty} />
        ) : (
          <ul className="sengoku-order-list">
            {inquiries.data.items.map((item) => (
              <li className="sengoku-order-card" key={item.requestId}>
                <div className="sengoku-order-card__head">
                  <strong>{refundReasonLabel(item.reason)}</strong>{' '}
                  {item.answeredAt !== null ? (
                    <StatusBadge tone="neutral" label={COPY.creatorAnswered} />
                  ) : item.expired ? (
                    /* ⚠️ `danger` にしない。遅れてもお受けする。 */
                    <StatusBadge tone="warning" label={COPY.creatorExpired} />
                  ) : (
                    <StatusBadge tone="progress" label={COPY.creatorDueAt} />
                  )}
                </div>

                <dl className="sengoku-detail-list">
                  <div>
                    <dt>{COPY.creatorDueAt}</dt>
                    <dd>{formatJst(item.dueAt)}</dd>
                  </div>
                </dl>

                {item.buyerStatement === null ? null : (
                  <>
                    <h3>{COPY.buyerStatementHeading}</h3>
                    {/* ⚠️ 文字として出す。HTML として解釈させない。 */}
                    <p>{item.buyerStatement}</p>
                  </>
                )}

                {item.answeredAt !== null ? (
                  <>
                    <h3>ご回答</h3>
                    <p>{item.answer}</p>
                    <p className="sengoku-form__hint">{formatJst(item.answeredAt)}</p>
                  </>
                ) : (
                  <AnswerInquiryForm requestId={item.requestId} expired={item.expired} />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>{COPY.receivablesHeading}</h2>
        <p className="sengoku-form__hint">{COPY.receivablesHint}</p>
        {!receivables.ok ? (
          <EmptyState title={creatorErrorMessage(receivables.reason, receivables.code)} />
        ) : receivables.data.items.length === 0 ? (
          <Notice tone="info" title={COPY.receivablesEmpty} />
        ) : (
          <>
            <p>
              {COPY.receivablesTotal}:{' '}
              <strong>{formatYen(receivables.data.outstandingAmount)}</strong>
            </p>
            <ul className="sengoku-order-list">
              {receivables.data.items.map((row) => (
                <li className="sengoku-order-card" key={row.id}>
                  <div className="sengoku-order-card__head">
                    <strong>{formatYen(row.amount)}</strong>{' '}
                    <StatusBadge tone="neutral" label={receivableStatusLabel(row.status)} />
                  </div>
                  <p className="sengoku-form__hint">{formatJst(row.createdAt)}</p>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </>
  );
}
