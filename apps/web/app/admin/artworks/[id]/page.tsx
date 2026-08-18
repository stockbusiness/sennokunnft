import { notFound } from 'next/navigation';
import { ArtworkImage, EmptyState, Notice, PageHeader, StatusBadge } from '@sengoku/ui';
import { fetchAdminArtwork, fetchAdminListingsOfArtwork } from '../../../../src/admin-client';
import {
  ADMIN_COPY,
  artworkStatusLabel,
  listingStatusLabel,
  shortAccountId,
} from '../../../../src/admin-copy';
import { displayStateLabel } from '../../../../src/display-state';
import {
  ArtworkArchiveButton,
  ArtworkDeleteForm,
  ArtworkEditForm,
  ArtworkImageForm,
  ArtworkPublishButton,
} from './forms';

export default async function AdminArtworkDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const result = await fetchAdminArtwork(id);

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

  const artwork = result.data;
  const listings = await fetchAdminListingsOfArtwork(artwork.id);
  const current = listings.ok ? listings.data.items[0] : undefined;

  return (
    <>
      <PageHeader title={artwork.title} />
      <StatusBadge
        label={artworkStatusLabel(artwork.status)}
        tone={artwork.status === 'published' ? 'success' : 'neutral'}
      />

      <ArtworkImage src={artwork.imageUrl} title={artwork.title} shape="wide" />

      <dl className="sengoku-definition-list">
        <div>
          <dt>URL 用の名前</dt>
          <dd>{artwork.slug}</dd>
        </div>
        <div>
          <dt>{ADMIN_COPY.creatorColumn}</dt>
          {/*
            ⚠️ 氏名・メールアドレスは出せない。平文で保持していないため（`UD-503`）。
               運営が見分けられるのはアカウントIDだけ。
          */}
          <dd>{shortAccountId(artwork.creatorAccountId)}</dd>
        </div>
        <div>
          <dt>発行数</dt>
          <dd>
            残り {artwork.availableSupply} / 全 {artwork.maxSupply}
            （お支払い待ち {artwork.reservedCount} ／ 発行済み {artwork.issuedCount}）
          </dd>
        </div>
        <div>
          <dt>販売</dt>
          <dd>
            {current === undefined
              ? '（販売設定なし）'
              : `${listingStatusLabel(current.status)}（店先では ${displayStateLabel(current.displayState)}）`}
          </dd>
        </div>
      </dl>

      <h2>{ADMIN_COPY.editHeading}</h2>
      <ArtworkEditForm
        artworkId={artwork.id}
        title={artwork.title}
        description={artwork.description}
        maxSupply={artwork.maxSupply}
        supplyEditable={artwork.status === 'draft'}
      />

      <h2>{ADMIN_COPY.imageHeading}</h2>
      {artwork.imageUrl === null ? (
        <Notice tone="alert" title="公開するには画像が必要です" />
      ) : null}
      <ArtworkImageForm artworkId={artwork.id} hasImage={artwork.imageUrl !== null} />

      <h2>{ADMIN_COPY.publishHeading}</h2>
      {artwork.status === 'published' ? (
        <>
          {/*
            ⚠️ 巻き込みで販売が止まることを、押す前に伝える。
               「公開をやめただけ」のつもりで販売まで終了させてしまうと、
               あとから同じ出品を復活させられない（`ended` は終端）。
          */}
          <Notice
            tone="alert"
            title="公開をやめると、この作品の販売も終了します"
            hint="終了した販売は元に戻せません。再び売るときは、価格を決め直して新しく作ります。"
          />
          <ArtworkArchiveButton artworkId={artwork.id} />
        </>
      ) : (
        <ArtworkPublishButton artworkId={artwork.id} />
      )}

      <h2>{ADMIN_COPY.deleteHeading}</h2>
      {/*
        ⚠️ 公開中は削除の入力欄そのものを出さない。
           出すと、確認の言葉まで打たせたうえで断ることになる。
           API 側でも拒否するので、ここで隠すのは事故を減らすためであって
           保護ではない。
      */}
      {artwork.status === 'published' ? (
        <Notice
          tone="alert"
          title={ADMIN_COPY.deleteBlockedByPublish}
          hint={ADMIN_COPY.deleteHint}
        />
      ) : (
        <ArtworkDeleteForm artworkId={artwork.id} />
      )}

      <p>
        <a href="/admin/artworks">一覧へ戻る</a>
      </p>
    </>
  );
}
