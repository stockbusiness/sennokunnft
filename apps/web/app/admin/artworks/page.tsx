import { EmptyState, PageHeader, StatusBadge } from '@sengoku/ui';
import { fetchAdminArtworks } from '../../../src/admin-client';
import { ADMIN_COPY, artworkStatusLabel } from '../../../src/admin-copy';

export default async function AdminArtworksPage() {
  const result = await fetchAdminArtworks();

  return (
    <>
      <PageHeader title={ADMIN_COPY.artworksTitle} description={ADMIN_COPY.artworksDescription} />
      <p>
        <a href="/admin/artworks/new">{ADMIN_COPY.newArtwork}</a>
      </p>

      {!result.ok ? (
        <EmptyState
          title={ADMIN_COPY.unavailableTitle(result.reason)}
          hint={ADMIN_COPY.unavailableHint}
        />
      ) : result.data.items.length === 0 ? (
        <EmptyState title={ADMIN_COPY.noArtworks} hint={ADMIN_COPY.noArtworksHint} />
      ) : (
        <div className="sengoku-table-scroll">
          <table className="sengoku-table">
            <thead>
              <tr>
                <th scope="col">作品名</th>
                <th scope="col">状態</th>
                <th scope="col">残り / 全数</th>
                <th scope="col"> </th>
              </tr>
            </thead>
            <tbody>
              {result.data.items.map((artwork) => (
                <tr key={artwork.id}>
                  <td>{artwork.title}</td>
                  <td>
                    <StatusBadge
                      label={artworkStatusLabel(artwork.status)}
                      tone={artwork.status === 'published' ? 'success' : 'neutral'}
                    />
                  </td>
                  <td>
                    {artwork.availableSupply} / {artwork.maxSupply}
                  </td>
                  <td>
                    <a href={`/admin/artworks/${artwork.id}`}>詳細</a>
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
