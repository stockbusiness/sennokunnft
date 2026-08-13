import { notFound } from 'next/navigation';
import { EmptyState, PageHeader, PriceTag, StatusBadge } from '@sengoku/ui';
import { fetchAdminListing } from '../../../../src/admin-client';
import { ADMIN_COPY, displayStateLabel, listingStatusLabel } from '../../../../src/admin-copy';

export default async function AdminListingDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const result = await fetchAdminListing(id);

  if (!result.ok) {
    if (result.reason === 'not_found') {
      notFound();
    }
    return (
      <EmptyState
        title={ADMIN_COPY.unavailableTitle(result.reason)}
        hint={ADMIN_COPY.unavailableHint}
      />
    );
  }

  const listing = result.data;

  return (
    <>
      <PageHeader title="販売の詳細" />
      <StatusBadge
        label={listingStatusLabel(listing.status)}
        tone={listing.status === 'active' ? 'success' : 'neutral'}
      />

      <dl className="sengoku-definition-list">
        <dt>価格</dt>
        <dd>
          <PriceTag price={listing.price} />
        </dd>
        <dt>利用者から見た表示</dt>
        <dd>{displayStateLabel(listing.displayState)}</dd>
        <dt>おひとり様あたりの上限</dt>
        <dd>{listing.maxQuantityPerOrder} 点</dd>
        <dt>販売期間</dt>
        <dd>
          {listing.startsAt ?? '指定なし'} 〜 {listing.endsAt ?? '指定なし'}
        </dd>
        <dt>表示順</dt>
        <dd>{listing.displayOrder}</dd>
      </dl>

      <p>{ADMIN_COPY.editViaApi}</p>
      <p>
        <a href="/admin/listings">一覧へ戻る</a>
      </p>
    </>
  );
}
