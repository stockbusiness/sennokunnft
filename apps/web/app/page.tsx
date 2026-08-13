import { EmptyState, PageHeader } from '@sengoku/ui';
import { SITE_COPY, resolveSiteName } from '../src/site';
import { getWebEnv } from '../src/env';

/**
 * トップページ。
 *
 * Phase 1 では作品カタログを実装しない（Phase 2）。
 * ここでは「起動してビルドでき、共有 UI パッケージを利用できる」ことを示す
 * 最小構成に留めている。
 */
export default function HomePage() {
  const siteName = resolveSiteName(getWebEnv().NEXT_PUBLIC_SITE_NAME);

  return (
    <>
      <PageHeader title={siteName} description={SITE_COPY.tagline} />
      <p>{SITE_COPY.phaseNotice}</p>
      <EmptyState title={SITE_COPY.emptyCatalogTitle} hint={SITE_COPY.emptyCatalogHint} />
    </>
  );
}
