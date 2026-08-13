import { ArtworkCard, EmptyState, PageHeader } from '@sengoku/ui';
import { fetchArtworkList } from '../src/api-client';
import { getWebEnv } from '../src/env';
import { resolveSiteName, SITE_COPY } from '../src/site';

/**
 * カタログ一覧。
 *
 * ⚠️ API が落ちていても**画面を落とさない**。
 * 一覧が出せないことと、サイト全体が壊れることは別で、
 * 後者にしてしまうと復旧までの体感被害が大きくなる。
 */
export default async function HomePage() {
  const siteName = resolveSiteName(getWebEnv().NEXT_PUBLIC_SITE_NAME);
  const result = await fetchArtworkList();

  return (
    <>
      <PageHeader title={siteName} description={SITE_COPY.tagline} />
      <p>{SITE_COPY.phaseNotice}</p>

      {!result.ok ? (
        <EmptyState
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
                price={artwork.price}
                availableSupply={artwork.availableSupply}
                maxSupply={artwork.maxSupply}
                purchasable={artwork.purchasable}
              />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
