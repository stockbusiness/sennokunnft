import { EmptyState, Notice, PageHeader, StatusBadge } from '@sengoku/ui';
import { fetchWalletDelivery } from '../../../../src/admin-client';
import { ADMIN_COPY } from '../../../../src/admin-copy';
import {
  DELIVERY_COPY,
  deliveryErrorLabel,
  deliveryStatusDescription,
  deliveryStatusTone,
  formatDateTime,
} from '../../../../src/delivery-copy';
import { ResendButton } from '../forms';

/**
 * お届け 1 件の詳細（管理画面・外部連携 指示書 §5）。
 *
 * ⚠️ **ここにも本文を出さない。** 「一覧では出さないが詳細では出す」は、
 * 見せない理由（お客さまの情報が含まれる）を満たさない。
 * 出すのは、提携先へ問い合わせるのに要る番号と、内容の照合値まで。
 */
export default async function AdminWalletDeliveryPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}) {
  const { id } = await params;
  const result = await fetchWalletDelivery(id);

  if (!result.ok) {
    return (
      <>
        <PageHeader title={DELIVERY_COPY.detailHeading} />
        <EmptyState
          title={ADMIN_COPY.unavailableTitle(result.reason)}
          hint={ADMIN_COPY.unavailableHint}
        />
        <p>
          <a href="/admin/wallet-deliveries">{DELIVERY_COPY.back}</a>
        </p>
      </>
    );
  }

  const delivery = result.data;

  return (
    <>
      <PageHeader title={DELIVERY_COPY.detailHeading} />

      <p>
        <StatusBadge
          label={deliveryStatusDescription(delivery.status)}
          tone={deliveryStatusTone(delivery.status)}
        />
      </p>

      <Notice tone="info" title={DELIVERY_COPY.payloadNote} hint={DELIVERY_COPY.payloadNoteHint} />

      <dl className="sengoku-definition-list">
        <div>
          <dt>{DELIVERY_COPY.detailEventId}</dt>
          <dd className="sengoku-code-inline">{delivery.eventId}</dd>
        </div>
        <div>
          <dt>{DELIVERY_COPY.detailCorrelationId}</dt>
          <dd className="sengoku-code-inline">{delivery.correlationId}</dd>
        </div>
        <div>
          <dt>{DELIVERY_COPY.detailEntitlementId}</dt>
          <dd className="sengoku-code-inline">{delivery.entitlementId}</dd>
        </div>
        <div>
          <dt>{DELIVERY_COPY.detailTarget}</dt>
          <dd>{delivery.targetSiteKey}</dd>
        </div>
        <div>
          <dt>{DELIVERY_COPY.columnAttempts}</dt>
          <dd>
            {String(delivery.attemptCount)} / {String(delivery.maxAttempts)}
          </dd>
        </div>
        {delivery.lastErrorCode === null ? null : (
          <div>
            <dt>{DELIVERY_COPY.columnError}</dt>
            <dd>
              {deliveryErrorLabel(delivery.lastErrorCode)}
              {/*
                ⚠️ 応答本文そのものではなく、運用が読むための要約だけ。
                   記録側で秘匿値を入れない約束になっている。
              */}
              {delivery.lastErrorMessage === null ? null : (
                <p className="sengoku-form__hint">{delivery.lastErrorMessage}</p>
              )}
            </dd>
          </div>
        )}
        <div>
          <dt>{DELIVERY_COPY.detailHash}</dt>
          <dd>
            <code className="sengoku-code-inline">{delivery.payloadHash}</code>
            <p className="sengoku-form__hint">{DELIVERY_COPY.detailHashHint}</p>
          </dd>
        </div>
        <div>
          <dt>{DELIVERY_COPY.detailNextRetry}</dt>
          <dd>{delivery.status === 'PENDING' ? formatDateTime(delivery.nextRetryAt) : '—'}</dd>
        </div>
        <div>
          <dt>{DELIVERY_COPY.detailCreated}</dt>
          <dd>{formatDateTime(delivery.createdAt)}</dd>
        </div>
        <div>
          <dt>{DELIVERY_COPY.detailDelivered}</dt>
          <dd>{delivery.deliveredAt === null ? '—' : formatDateTime(delivery.deliveredAt)}</dd>
        </div>
      </dl>

      {delivery.canResend ? (
        <ResendButton deliveryId={delivery.id} />
      ) : (
        <Notice
          tone="info"
          title={DELIVERY_COPY.resendBlocked}
          hint={DELIVERY_COPY.resendBlockedHint}
        />
      )}

      <p>
        <a href="/admin/wallet-deliveries">{DELIVERY_COPY.back}</a>
      </p>
    </>
  );
}
