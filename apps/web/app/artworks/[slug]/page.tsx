import { notFound } from 'next/navigation';
import { EmptyState, PageHeader, PriceTag, StatusBadge } from '@sengoku/ui';
import { fetchArtworkDetail } from '../../../src/api-client';
import { SITE_COPY } from '../../../src/site';

/** 表示状態を、利用者向けの言い回しに直す。 */
const DISPLAY_STATE_LABEL: Record<string, string> = {
  scheduled: '販売開始前です',
  ended: '販売は終了しました',
  sold_out: '完売しました',
  not_available: 'ただいま販売しておりません',
};

export default async function ArtworkDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const result = await fetchArtworkDetail(slug);

  if (!result.ok) {
    if (result.reason === 'not_found') {
      // 未公開の作品もここに来る。存在の有無を区別しない。
      notFound();
    }
    return (
      <EmptyState
        title={SITE_COPY.catalogUnavailableTitle}
        hint={SITE_COPY.catalogUnavailableHint}
      />
    );
  }

  const artwork = result.data;

  return (
    <>
      <PageHeader title={artwork.title} />
      <p>{artwork.description}</p>

      <p>
        残り {artwork.availableSupply} 点 / 全 {artwork.maxSupply} 点
      </p>

      {artwork.price === null ? (
        <StatusBadge label="準備中" tone="neutral" />
      ) : (
        <PriceTag price={artwork.price} />
      )}

      {artwork.purchasable ? (
        // お申し込みは Phase 3。ここにボタンを置かないのは、
        // 押せるのに何も起きない導線を作らないため。
        <p>{SITE_COPY.purchaseComingSoon}</p>
      ) : (
        <StatusBadge
          label={DISPLAY_STATE_LABEL[artwork.displayState] ?? 'ただいまお求めいただけません'}
          tone="warning"
        />
      )}

      <p>
        <a href="/">{SITE_COPY.backToCatalog}</a>
      </p>
    </>
  );
}
