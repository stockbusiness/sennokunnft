import { EmptyState, PageHeader, PriceTag, StatusBadge } from '@sengoku/ui';
import { fetchAdminListings } from '../../../src/admin-client';
import { ADMIN_COPY, displayStateLabel, listingStatusLabel } from '../../../src/admin-copy';

export default async function AdminListingsPage() {
  const result = await fetchAdminListings();

  return (
    <>
      <PageHeader title={ADMIN_COPY.listingsTitle} description={ADMIN_COPY.listingsDescription} />
      <p>
        <a href="/admin/listings/new">{ADMIN_COPY.newListing}</a>
      </p>

      {!result.ok ? (
        <EmptyState
          title={ADMIN_COPY.unavailableTitle(result.reason)}
          hint={ADMIN_COPY.unavailableHint}
        />
      ) : result.data.items.length === 0 ? (
        <EmptyState title={ADMIN_COPY.noListings} hint={ADMIN_COPY.noListingsHint} />
      ) : (
        <div className="sengoku-table-scroll">
          <table className="sengoku-table">
            <thead>
              <tr>
                <th scope="col">価格</th>
                <th scope="col">状態</th>
                <th scope="col">利用者から見た表示</th>
                <th scope="col">表示順</th>
                <th scope="col"> </th>
              </tr>
            </thead>
            <tbody>
              {result.data.items.map((listing) => (
                <tr key={listing.id}>
                  <td>
                    <PriceTag price={listing.price} />
                  </td>
                  <td>
                    <StatusBadge
                      label={listingStatusLabel(listing.status)}
                      tone={listing.status === 'active' ? 'success' : 'neutral'}
                    />
                  </td>
                  <td>{displayStateLabel(listing.displayState)}</td>
                  <td>{listing.displayOrder}</td>
                  <td>
                    <a href={`/admin/listings/${listing.id}`}>詳細</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
