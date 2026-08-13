import { notFound } from 'next/navigation';
import { EmptyState, PageHeader, StatusBadge } from '@sengoku/ui';
import { fetchAdminArtwork } from '../../../../src/admin-client';
import { ADMIN_COPY, artworkStatusLabel } from '../../../../src/admin-copy';

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

  return (
    <>
      <PageHeader title={artwork.title} />
      <StatusBadge
        label={artworkStatusLabel(artwork.status)}
        tone={artwork.status === 'published' ? 'success' : 'neutral'}
      />

      <dl className="sengoku-definition-list">
        <dt>URL 用の名前</dt>
        <dd>{artwork.slug}</dd>
        <dt>説明</dt>
        <dd>{artwork.description === '' ? '（未設定）' : artwork.description}</dd>
        <dt>発行数</dt>
        <dd>
          残り {artwork.availableSupply} / 全 {artwork.maxSupply}
          （お支払い待ち {artwork.reservedCount} ／ 発行済み {artwork.issuedCount}）
        </dd>
        <dt>画像</dt>
        <dd>
          {artwork.imageUrl === null
            ? '（未登録）公開するには画像が必要です。'
            : `${artwork.imageContentType ?? ''}（${String(artwork.imageByteSize ?? 0)} バイト）`}
        </dd>
      </dl>

      <p>{ADMIN_COPY.editViaApi}</p>
      <p>
        <a href="/admin/artworks">一覧へ戻る</a>
      </p>
    </>
  );
}
