import { ArtworkImage, EmptyState, Notice, PageHeader, StatusBadge } from '@sengoku/ui';
import { fetchMyArtwork, fetchMyListings } from '../../../../src/creator-client';
import { CREATOR_COPY, creatorErrorMessage } from '../../../../src/creator-copy';
import { artworkStatusLabel, listingStatusLabel } from '../../../../src/admin-copy';
import { displayStateLabel } from '../../../../src/display-state';
import { ArchiveButton, ImageForm, ListingForm, ListingStateButtons, PublishButton } from './forms';

export default async function CreatorArtworkPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const artwork = await fetchMyArtwork(id);
  if (!artwork.ok) {
    return <EmptyState title={creatorErrorMessage(artwork.reason)} hint="" />;
  }

  const listings = await fetchMyListings(id);
  const current = listings.ok ? listings.data.items[0] : undefined;

  return (
    <>
      <PageHeader title={artwork.data.title} />
      <StatusBadge
        label={artworkStatusLabel(artwork.data.status)}
        tone={artwork.data.status === 'published' ? 'success' : 'neutral'}
      />

      <ArtworkImage src={artwork.data.imageUrl} title={artwork.data.title} shape="wide" />

      <dl className="sengoku-definition-list">
        <div>
          <dt>URL に使う文字</dt>
          <dd>{artwork.data.slug}</dd>
        </div>
        <div>
          <dt>発行する数</dt>
          <dd>
            残り {artwork.data.availableSupply} / 全 {artwork.data.maxSupply}
          </dd>
        </div>
        {artwork.data.description === '' ? null : (
          <div>
            <dt>説明</dt>
            <dd>{artwork.data.description}</dd>
          </div>
        )}
      </dl>

      <h2>画像</h2>
      {artwork.data.imageUrl === null ? (
        <Notice tone="alert" title="公開するには画像が必要です" />
      ) : null}
      <ImageForm artworkId={artwork.data.id} />

      <h2>公開</h2>
      {artwork.data.status === 'published' ? (
        <ArchiveButton artworkId={artwork.data.id} />
      ) : (
        <PublishButton artworkId={artwork.data.id} />
      )}

      <h2>販売</h2>
      {/* ⚠️ 買えないことを隠さない。並べられると買えるは別。 */}
      <Notice
        tone="alert"
        title={CREATOR_COPY.notSellableNotice}
        hint={CREATOR_COPY.notSellableHint}
      />

      {artwork.data.status !== 'published' ? (
        <p>作品を公開すると、価格を決められるようになります。</p>
      ) : current === undefined ? (
        <ListingForm artworkId={artwork.data.id} />
      ) : (
        <>
          <dl className="sengoku-definition-list">
            <div>
              <dt>価格</dt>
              <dd>
                ¥{current.price.amount.toLocaleString('ja-JP')}
                <span className="sengoku-price__note">（税込）</span>
              </dd>
            </div>
            <div>
              <dt>状態</dt>
              {/*
                ⚠️ 同じ言葉を二度出さない。「販売中（販売中）」になる。
                   出品の状態と、お客様から見える状態は普段一致する。
                   食い違うのは日時で切り替わるときだけなので、そのときだけ添える。
              */}
              <dd>
                {listingStatusLabel(current.status)}
                {displayStateLabel(current.displayState) === listingStatusLabel(current.status)
                  ? null
                  : `（店先では ${displayStateLabel(current.displayState)}）`}
              </dd>
            </div>
          </dl>
          <ListingStateButtons
            artworkId={artwork.data.id}
            listingId={current.id}
            status={current.status}
          />
        </>
      )}

      <p>
        <a href="/creator">{CREATOR_COPY.backToList}</a>
      </p>
    </>
  );
}
