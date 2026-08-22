import Link from 'next/link';
import { notFound } from 'next/navigation';
import { EmptyState, Notice, PageHeader, StatusBadge } from '@sengoku/ui';
import { fetchRefundRequest } from '../../../../src/admin-client';
import { ADMIN_COPY } from '../../../../src/admin-copy';
import { formatDateTime, shortId } from '../../../../src/order-copy';
import {
  clawbackBearerLabel,
  entitlementDispositionLabel,
  REFUND_REQUEST_COPY as COPY,
  refundCategoryLabel,
  refundEventLabel,
  refundReasonLabel,
  refundRequestStatusLabel,
  refundRequestStatusTone,
} from '../../../../src/refund-request-copy';
import { ApproveForm, AskCreatorForm, ExecuteForm, InvestigateForm, RejectForm } from '../forms';

/**
 * お申し出 1 件（方針整理 2026-08-22）。
 *
 * ⚠️ **押せる操作だけを出す。** 状態から決まるので、画面にしきい値や
 * 事由の規則を書き写さない。押せない操作を出しても、API が断るだけで
 * 「なぜ押せないか」は伝わらない。
 *
 * ⚠️ **運営の記録と、お客さまの経緯を別の節にする。** 混ぜると、
 * 購入者へお見せする画面を作ったときに運営の記録まで出る。
 */
export default async function AdminRefundRequestPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}) {
  const { id } = await params;
  const result = await fetchRefundRequest(id);

  if (!result.ok) {
    if (result.reason === 'not_found') {
      notFound();
    }
    return (
      <>
        <PageHeader title={COPY.detailHeading} />
        <EmptyState
          title={ADMIN_COPY.unavailableTitle(result.reason)}
          hint={ADMIN_COPY.unavailableHint}
        />
      </>
    );
  }

  const {
    request,
    note,
    buyerStatement,
    inquiry,
    events,
    remainingAmount,
    clawbackBearer,
    clawbackBearerDefault,
    clawbackBearerOverridden,
  } = result.data;

  /*
    どの操作を出すか。
    ⚠️ **状態だけで決める。** 事由の規則（作家さまへ聞けるか）や、
       しきい値（二重承認が要るか）は API 側の判断で、画面は知らない。
  */
  const canInvestigate = request.status === 'submitted' || request.status === 'creator_review';
  const canAskCreator =
    request.status === 'submitted' && request.category === 'creator_confirmation';
  const canDecide = request.status === 'reviewed' || request.status === 'approval_pending';
  const canReject =
    canDecide || request.status === 'submitted' || request.status === 'creator_review';
  const canExecute = request.status === 'approved' || request.status === 'execution_failed';

  return (
    <>
      <PageHeader title={COPY.detailHeading} />
      <p>
        <Link className="sengoku-link" href="/admin/refund-requests">
          ← {COPY.adminTitle}
        </Link>
      </p>

      <section>
        <p>
          <StatusBadge
            tone={refundRequestStatusTone(request.status)}
            label={refundRequestStatusLabel(request.status)}
          />
        </p>

        <dl className="sengoku-detail-list">
          <div>
            <dt>{COPY.fieldReason}</dt>
            <dd>{refundReasonLabel(request.reason)}</dd>
          </div>
          <div>
            <dt>{COPY.fieldCategory}</dt>
            {/* ⚠️ 事由から決まる。選び直せない、と分かる言葉にしてある。 */}
            <dd>{refundCategoryLabel(request.category)}</dd>
          </div>
          <div>
            <dt>{COPY.fieldOrder}</dt>
            <dd>
              <Link className="sengoku-link" href={`/admin/orders/${request.orderId}`}>
                {shortId(request.orderId)}
              </Link>
            </dd>
          </div>
          <div>
            <dt>{COPY.fieldAmount}</dt>
            <dd>{request.amount.toLocaleString('ja-JP')} 円</dd>
          </div>
          <div>
            <dt>{COPY.fieldRemaining}</dt>
            {/* ⚠️ 注文から取り直した値。申し出へ焼き付けた額ではない。 */}
            <dd>{remainingAmount.toLocaleString('ja-JP')} 円</dd>
          </div>
          <div>
            <dt>{COPY.bearerLabel}</dt>
            <dd>
              {clawbackBearerLabel(clawbackBearer)}
              {/*
                ⚠️ **既定から変えたことを出す。** 値だけ出しても、それが
                   既定だったのか判断だったのかが読めない。
              */}
              {!clawbackBearerOverridden ? null : (
                <>
                  {' '}
                  <StatusBadge tone="warning" label={COPY.bearerOverriddenBadge} />
                </>
              )}
            </dd>
          </div>
          <div>
            <dt>{COPY.fieldDisposition}</dt>
            <dd>{entitlementDispositionLabel(request.entitlementDisposition)}</dd>
          </div>
          <div>
            <dt>{COPY.fieldRequestedBy}</dt>
            <dd>
              {request.requestedByAccountId === null ? '—' : shortId(request.requestedByAccountId)}
            </dd>
          </div>
          <div>
            <dt>{COPY.fieldReviewedBy}</dt>
            <dd>
              {request.reviewedByAccountId === null ? '—' : shortId(request.reviewedByAccountId)}
            </dd>
          </div>
          <div>
            <dt>{COPY.fieldApprovedBy}</dt>
            <dd>
              {request.approvedByAccountId === null ? '—' : shortId(request.approvedByAccountId)}
            </dd>
          </div>
          <div>
            <dt>{COPY.fieldCreatedAt}</dt>
            <dd>{formatDateTime(request.createdAt)}</dd>
          </div>
          <div>
            <dt>{COPY.fieldUpdatedAt}</dt>
            <dd>{formatDateTime(request.updatedAt)}</dd>
          </div>
        </dl>

        {!request.dualApprovalRequired ? null : (
          <Notice
            tone="alert"
            title="この金額は、お二人のご承認が必要です"
            hint="お申し出をされたご本人と、1 人目に承認された方は、2 人目になれません。"
          />
        )}
        {!request.approvedAsException ? null : (
          <Notice tone="alert" title="原則お受けしない事由を、例外としてお通ししました" />
        )}
        {request.rejectionNote === null ? null : (
          <Notice tone="info" title="却下の理由" hint={request.rejectionNote} />
        )}
      </section>

      <section>
        <h2>{COPY.buyerStatementHeading}</h2>
        {/* ⚠️ 文字として出す。HTML として解釈させない（React が既定でそうする）。 */}
        <p>{buyerStatement ?? COPY.buyerStatementEmpty}</p>
      </section>

      <section>
        <h2>{COPY.noteHeading}</h2>
        <p className="sengoku-form__hint">{COPY.noteHint}</p>
        <p>{note ?? COPY.noteEmpty}</p>
      </section>

      {inquiry === null ? null : (
        <section>
          <h2>{COPY.askCreatorHeading}</h2>
          <dl className="sengoku-detail-list">
            <div>
              <dt>作家さま</dt>
              <dd>{shortId(inquiry.creatorAccountId)}</dd>
            </div>
            <div>
              <dt>{COPY.creatorDueAt}</dt>
              <dd>{formatDateTime(inquiry.dueAt)}</dd>
            </div>
            <div>
              <dt>ご回答</dt>
              <dd>
                {inquiry.answeredAt === null
                  ? inquiry.expired
                    ? COPY.creatorExpired
                    : 'お待ちしています'
                  : formatDateTime(inquiry.answeredAt)}
              </dd>
            </div>
          </dl>
          {inquiry.answer === null ? null : <p>{inquiry.answer}</p>}
          {inquiry.attachmentKeys.length === 0 ? null : (
            <p>添付 {inquiry.attachmentKeys.length} 件</p>
          )}
          {!inquiry.expired || inquiry.answeredAt !== null ? null : (
            <Notice
              tone="info"
              title="ご回答をお待ちにならず、審査を進められます"
              hint={COPY.askCreatorHint}
            />
          )}
        </section>
      )}

      {!canAskCreator ? null : (
        <section>
          <h2>{COPY.askCreatorHeading}</h2>
          <AskCreatorForm requestId={request.id} />
        </section>
      )}

      {!canInvestigate ? null : (
        <section>
          <h2>{COPY.investigateHeading}</h2>
          <InvestigateForm requestId={request.id} />
        </section>
      )}

      {!canDecide ? null : (
        <section>
          <h2>{COPY.approveHeading}</h2>
          <ApproveForm
            requestId={request.id}
            remainingAmount={remainingAmount}
            isExcluded={request.category === 'excluded'}
            bearer={clawbackBearerDefault}
          />
        </section>
      )}

      {!canReject ? null : (
        <section>
          <h2>{COPY.rejectHeading}</h2>
          <RejectForm requestId={request.id} />
        </section>
      )}

      {!canExecute ? null : (
        <section>
          <h2>{COPY.executeHeading}</h2>
          <ExecuteForm requestId={request.id} />
        </section>
      )}

      <section>
        <h2>{COPY.eventsHeading}</h2>
        <p className="sengoku-form__hint">{COPY.eventsHint}</p>
        {events.length === 0 ? (
          <Notice tone="info" title={COPY.eventsEmpty} />
        ) : (
          <ol className="sengoku-timeline">
            {events.map((event) => (
              <li key={event.id}>
                <strong>{refundEventLabel(event.action)}</strong>{' '}
                <span>{formatDateTime(event.createdAt)}</span>
                {event.actorAccountId === null ? null : (
                  <span> / {shortId(event.actorAccountId)}</span>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}
