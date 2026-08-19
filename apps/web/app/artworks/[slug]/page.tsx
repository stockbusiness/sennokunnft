import { notFound } from 'next/navigation';
import { ArtworkImage, Notice, PriceTag, StatusBadge } from '@sengoku/ui';
import { fetchArtworkDetail } from '../../../src/api-client';
import { displayStateLabel } from '../../../src/display-state';
import { SITE_COPY } from '../../../src/site';

export default async function ArtworkDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const result = await fetchArtworkDetail(slug);

  if (!result.ok) {
    if (result.reason === 'not_found') {
      // 未公開の作品もここに来る。存在の有無を区別しない。
      notFound();
    }
    return (
      <Notice
        tone="alert"
        title={SITE_COPY.catalogUnavailableTitle}
        hint={SITE_COPY.catalogUnavailableHint}
      />
    );
  }

  const artwork = result.data;

  return (
    /*
      画像を先に置く。買う人が最初に見るのは絵で、
      名前や値段はその次に確かめるもの。
      狭い画面では 1 列に落ち、画像・説明・価格の順に縦へ並ぶ。
    */
    <div className="sengoku-artwork-detail">
      <div className="sengoku-artwork-detail__figure">
        <ArtworkImage src={artwork.imageUrl} title={artwork.title} shape="square" />
      </div>

      <div className="sengoku-artwork-detail__side">
        <h1>{artwork.title}</h1>

        {artwork.purchasable ? (
          <StatusBadge label={displayStateLabel('on_sale')} tone="success" />
        ) : (
          <StatusBadge label={displayStateLabel(artwork.displayState)} tone="warning" />
        )}

        <p className="sengoku-artwork-detail__description">{artwork.description}</p>

        <dl className="sengoku-facts">
          <dt>{SITE_COPY.supplyLabel}</dt>
          <dd>
            残り {artwork.availableSupply} 点 / 全 {artwork.maxSupply} 点
          </dd>
          <dt>{SITE_COPY.priceLabel}</dt>
          <dd>
            {artwork.price === null ? SITE_COPY.priceUnset : <PriceTag price={artwork.price} />}
          </dd>
          {artwork.maxQuantityPerOrder === null ? null : (
            <>
              <dt>{SITE_COPY.perOrderLabel}</dt>
              <dd>{artwork.maxQuantityPerOrder} 点まで</dd>
            </>
          )}
        </dl>

        {/*
          お申し込みの導線。

          ⚠️ **買えるときだけ出す。** 押せるのに何も起きないボタンを置かない。
          ⚠️ **ここでログインを要求しない。** 先にログインさせてから
             「売り切れです」と言うのは、いちばん人を怒らせる順序。
             確認画面で在庫を見てから案内する。
          ⚠️ 出品が無い（`listingId` が空）ときは、押す先が無いので出さない。
        */}
        {artwork.purchasable && artwork.listingId !== null ? (
          <p className="sengoku-artwork-detail__action">
            <a
              className="sengoku-button sengoku-button--large"
              href={`/checkout/${artwork.listingId}`}
            >
              {SITE_COPY.purchaseCta}
            </a>
          </p>
        ) : artwork.purchasable ? (
          <p className="sengoku-action-pending">{SITE_COPY.purchaseComingSoon}</p>
        ) : null}

        <p className="sengoku-back-link">
          <a href="/">← {SITE_COPY.backToCatalog}</a>
        </p>
      </div>
    </div>
  );
}
