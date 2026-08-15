import { ArtworkCard, EmptyState, Notice, PageHeader } from '@sengoku/ui';
import { fetchArtworkList } from '../src/api-client';
import { displayStateLabel } from '../src/display-state';
import { SITE_COPY } from '../src/site';

/**
 * カタログ一覧。
 *
 * ⚠️ API が落ちていても**画面を落とさない**。
 * 一覧が出せないことと、サイト全体が壊れることは別で、
 * 後者にしてしまうと復旧までの体感被害が大きくなる。
 *
 * サイト名は共通の頭（`SiteHeader`）が出すので、ここでは繰り返さない。
 * 同じ名前が 2 か所に並ぶと、どちらがページの題なのか分からなくなる。
 */
export default async function HomePage() {
  const result = await fetchArtworkList();

  return (
    <>
      <PageHeader title={SITE_COPY.catalogTitle} description={SITE_COPY.tagline} />
      <Notice title={SITE_COPY.phaseNotice} />

      {!result.ok ? (
        <Notice
          tone="alert"
          title={SITE_COPY.catalogUnavailableTitle}
          hint={SITE_COPY.catalogUnavailableHint}
        />
      ) : result.data.items.length === 0 ? (
        <EmptyState title={SITE_COPY.emptyCatalogTitle} hint={SITE_COPY.emptyCatalogHint} />
      ) : (
        <ul className="sengoku-artwork-grid">
          {result.data.items.map((artwork) => (
            <li key={artwork.id}>
              <ArtworkCard
                title={artwork.title}
                href={`/artworks/${artwork.slug}`}
                // ⚠️ URL はサーバーが解決したものをそのまま使う。
                //    キーから組み立てると、公開ドメインの設定が 2 か所になる。
                imageUrl={artwork.imageUrl}
                price={artwork.price}
                availableSupply={artwork.availableSupply}
                maxSupply={artwork.maxSupply}
                purchasable={artwork.purchasable}
                statusLabel={displayStateLabel(artwork.displayState)}
              />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
