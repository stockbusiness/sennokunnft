import { notFound } from 'next/navigation';
import { EmptyState, Notice, PageHeader, StatusBadge } from '@sengoku/ui';
import { fetchCreatorDetail } from '../../../../src/admin-client';
import { ADMIN_COPY } from '../../../../src/admin-copy';
import { formatDateTime, shortId } from '../../../../src/order-copy';
import { payoutStatusLabel, payoutStatusTone } from '../../../../src/payout-copy';
import {
  CREATOR_DIRECTORY_COPY as COPY,
  creatorSalesTermsLabel,
  formatSignedYen,
} from '../../../../src/reporting-copy';

/**
 * 作家さまの詳細（`UD-124` の一部）。
 *
 * ⚠️ **ここは入口であって台帳ではない。** 金額の正は精算の画面。ここに
 * 数字を作り直さない（作ると 2 か所で食い違う）。
 */
export default async function AdminCreatorDetailPage({
  params,
}: {
  readonly params: Promise<{ accountId: string }>;
}) {
  const { accountId } = await params;
  const result = await fetchCreatorDetail(accountId);

  if (!result.ok) {
    if (result.reason === 'not_found') {
      notFound();
    }
    return (
      <>
        <PageHeader title={COPY.title} />
        <EmptyState
          title={ADMIN_COPY.unavailableTitle(result.reason)}
          hint={ADMIN_COPY.unavailableHint}
        />
      </>
    );
  }

  const { creator, bio, invoiceNumber, payouts } = result.data;

  return (
    <>
      <PageHeader
        title={creator.displayName ?? COPY.noName}
        description={creator.shopName ?? COPY.detailHeading}
      />

      <p>
        <span className="sengoku-code-inline">{shortId(creator.accountId)}</span>{' '}
        <StatusBadge
          tone={creator.salesTermsAcceptedAt === null ? 'warning' : 'success'}
          label={creatorSalesTermsLabel(creator)}
        />{' '}
        <StatusBadge
          tone={creator.hasPayoutAccount ? 'success' : 'warning'}
          label={
            creator.hasPayoutAccount ? COPY.payoutAccountRegistered : COPY.payoutAccountMissing
          }
        />
      </p>

      {/* ⚠️ 値はここに出ない。読むのは精算の画面から（権限と記録が要る）。 */}
      <p className="sengoku-form__hint">{COPY.payoutAccountHint}</p>

      <dl className="sengoku-facts">
        <dt>{COPY.columnArtworks}</dt>
        <dd>{creator.artworkCount.toLocaleString('ja-JP')} 点</dd>
        <dt>{COPY.columnListings}</dt>
        <dd>{creator.activeListingCount.toLocaleString('ja-JP')} 点</dd>
        <dt>{COPY.columnOrders}</dt>
        <dd>{creator.orderCount.toLocaleString('ja-JP')} 件</dd>
        <dt>{COPY.columnGross}</dt>
        <dd>{creator.grossAmount.toLocaleString('ja-JP')} 円</dd>
        <dt>{COPY.columnRefunded}</dt>
        <dd>{formatSignedYen(creator.refundedAmount)}</dd>
        <dt>{COPY.columnLastSold}</dt>
        <dd>{creator.lastSoldAt === null ? '—' : formatDateTime(creator.lastSoldAt)}</dd>
        <dt>{COPY.columnSalesTerms}</dt>
        <dd>
          {creator.salesTermsAcceptedAt === null
            ? COPY.salesTermsPending
            : formatDateTime(creator.salesTermsAcceptedAt)}
        </dd>
        {invoiceNumber === null ? null : (
          <>
            <dt>{COPY.invoiceLabel}</dt>
            <dd>
              <code>{invoiceNumber}</code>
              <span className="sengoku-form__hint"> {COPY.invoiceHint}</span>
            </dd>
          </>
        )}
      </dl>

      {bio === null ? null : (
        <section>
          <h2>{COPY.bioLabel}</h2>
          {/* ⚠️ 文字として描く。HTML として解釈しない。 */}
          <p>{bio}</p>
        </section>
      )}

      <section>
        <h2>{COPY.payoutsHeading}</h2>
        {payouts.length === 0 ? (
          <p>{COPY.payoutsEmpty}</p>
        ) : (
          <ul className="sengoku-order-list">
            {payouts.map((payout) => (
              <li className="sengoku-order-card" key={payout.id}>
                <div className="sengoku-order-card__head">
                  <strong>
                    <a href={`/admin/payouts/${payout.id}`}>{payout.periodKey}</a>
                  </strong>{' '}
                  <StatusBadge
                    tone={payoutStatusTone(payout.status as 'draft' | 'confirmed' | 'paid')}
                    label={payoutStatusLabel(payout.status as 'draft' | 'confirmed' | 'paid')}
                  />
                </div>
                <dl className="sengoku-facts">
                  <dt>お支払額</dt>
                  <dd>{formatSignedYen(payout.netAmount)}</dd>
                  <dt>期日</dt>
                  <dd>{formatDateTime(payout.dueAt)}</dd>
                </dl>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/*
        ⚠️ **無いものは「無い」と書く。** 探して見つからないより早い。
      */}
      <Notice tone="info" title={COPY.noSuspendNotice} hint={COPY.noSuspendHint} />

      <p className="sengoku-back-link">
        <a href="/admin/creators">{COPY.backLink}</a>
      </p>
    </>
  );
}
