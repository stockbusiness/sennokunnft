import { ArtworkImage, EmptyState, Notice, PageHeader, StatusBadge } from '@sengoku/ui';
import { fetchMyCollectibles } from '../../../src/order-client';
import { ACCOUNT_COPY, deliveryStateLabel, deliveryTone } from '../../../src/account-copy';
import { formatDateTime } from '../../../src/order-copy';

/**
 * お受け取りの作品（P0-3）。
 *
 * ⚠️ **Web3 用語を出さない。** 「NFT」「トークン」「Mint」を書かない。
 * ここに並ぶのは、買った方から見れば**買った作品**である。
 */
export default async function AccountCollectiblesPage() {
  const result = await fetchMyCollectibles();

  if (!result.ok) {
    return (
      <>
        <PageHeader title={ACCOUNT_COPY.collectiblesTitle} />
        <Notice
          tone="alert"
          title={
            result.reason === 'unauthenticated'
              ? 'ログインが必要です'
              : '作品の一覧を読み込めませんでした'
          }
          hint={
            result.reason === 'unauthenticated'
              ? 'ご登録のメールアドレスでログインのうえ、もう一度お試しください。'
              : 'しばらくしてから、もう一度お試しください。'
          }
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={ACCOUNT_COPY.collectiblesTitle}
        description={ACCOUNT_COPY.collectiblesDescription}
      />

      {result.data.items.length === 0 ? (
        <EmptyState title={ACCOUNT_COPY.noCollectibles} hint={ACCOUNT_COPY.noCollectiblesHint} />
      ) : (
        <ul className="sengoku-artwork-grid">
          {result.data.items.map((item) => (
            <li key={item.entitlementId}>
              <article className="sengoku-artwork-card">
                <a href={`/artworks/${item.artworkSlug}`} className="sengoku-artwork-card__link">
                  <ArtworkImage src={item.imageUrl} title={item.artworkTitle} shape="wide" />
                  <h2 className="sengoku-artwork-card__title">{item.artworkTitle}</h2>
                </a>
                <div className="sengoku-artwork-card__body">
                  {/* ⚠️ 色だけで区別しない。言葉で状態を伝える。 */}
                  <StatusBadge
                    label={deliveryStateLabel(item.status)}
                    tone={deliveryTone(item.status)}
                  />
                  {item.creatorName === null ? null : (
                    <p className="sengoku-artwork-card__creator">
                      {ACCOUNT_COPY.creatorLabel}: {item.creatorName}
                    </p>
                  )}
                  <p className="sengoku-artwork-card__supply">
                    {ACCOUNT_COPY.serialLabel} {item.serialNo} ／ {ACCOUNT_COPY.acquiredAtLabel}{' '}
                    {formatDateTime(item.acquiredAt)}
                  </p>
                  <p className="sengoku-back-link">
                    <a href={`/account/orders/${item.orderId}`}>
                      {ACCOUNT_COPY.orderNumberLabel} {item.orderNumber}
                    </a>
                  </p>
                </div>
              </article>
            </li>
          ))}
        </ul>
      )}

      <p className="sengoku-back-link">
        <a href="/account">{ACCOUNT_COPY.backToAccount}</a>
      </p>
    </>
  );
}
