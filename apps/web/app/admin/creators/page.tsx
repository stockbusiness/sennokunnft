import { EmptyState, Notice, PageHeader, StatusBadge } from '@sengoku/ui';
import { fetchCreatorDirectory } from '../../../src/admin-client';
import { ADMIN_COPY } from '../../../src/admin-copy';
import { formatDateTime, shortId } from '../../../src/order-copy';
import {
  CREATOR_DIRECTORY_COPY as COPY,
  creatorSalesTermsLabel,
  formatSignedYen,
} from '../../../src/reporting-copy';

/**
 * 作家さまの一覧（`UD-124` の一部）。
 *
 * ⚠️ **止める口を置かない。** 作家さま単位で出品を止める操作は、止めた
 * ときに何が起きるか（進行中のご注文・発行待ちの受取権・精算）を決めてから
 * 作る。**見る画面のついでに足さない。**
 *
 * ⚠️ **お振込先の値もご連絡先も出ない。** 前者は精算の画面から（権限と
 * 記録が要る）。後者はそもそも持っていない（`UD-503`）。
 */
export default async function AdminCreatorsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ keyword?: string }>;
}) {
  const params = await searchParams;
  const keyword = params.keyword ?? '';
  const result = await fetchCreatorDirectory(keyword);

  if (!result.ok) {
    return (
      <>
        <PageHeader title={COPY.title} />
        <EmptyState
          title={ADMIN_COPY.unavailableTitle(result.reason)}
          hint={ADMIN_COPY.unavailableHint}
        />
      </>
    );
  }

  const { items, limit } = result.data;

  return (
    <>
      <PageHeader title={COPY.title} description={COPY.description} />

      {/* ⚠️ 押しても効かないボタンを並べない。GET で絞るだけ。 */}
      <form className="sengoku-form" method="get" action="/admin/creators">
        <div className="sengoku-form__field">
          <label className="sengoku-form__label" htmlFor="creator-keyword">
            {COPY.searchLabel}
          </label>
          <input
            className="sengoku-form__input"
            id="creator-keyword"
            name="keyword"
            type="search"
            defaultValue={keyword}
          />
        </div>
        <button className="sengoku-button sengoku-button--quiet" type="submit">
          {COPY.searchSubmit}
        </button>
      </form>

      <p className="sengoku-form__hint">{COPY.payoutAccountHint}</p>

      {/* ⚠️ 黙って切らない。上限に達したことを伝える。 */}
      {items.length >= limit ? <Notice tone="info" title={COPY.limited(limit)} /> : null}

      {items.length === 0 ? (
        <EmptyState title={COPY.empty} />
      ) : (
        <ul className="sengoku-order-list">
          {items.map((row) => (
            <li className="sengoku-order-card" key={row.accountId}>
              <div className="sengoku-order-card__head">
                {/* ⚠️ 文字として描く。HTML として解釈しない。 */}
                <strong>
                  <a href={`/admin/creators/${row.accountId}`}>{row.displayName ?? COPY.noName}</a>
                </strong>{' '}
                <span className="sengoku-code-inline">{shortId(row.accountId)}</span>{' '}
                {row.salesTermsAcceptedAt === null ? (
                  <StatusBadge tone="warning" label={creatorSalesTermsLabel(row)} />
                ) : null}
                {row.hasPayoutAccount ? null : (
                  <StatusBadge tone="warning" label={COPY.payoutAccountMissing} />
                )}
              </div>
              {row.shopName === null ? null : <p>{row.shopName}</p>}
              <dl className="sengoku-facts">
                <dt>{COPY.columnArtworks}</dt>
                <dd>{row.artworkCount.toLocaleString('ja-JP')} 点</dd>
                <dt>{COPY.columnListings}</dt>
                <dd>{row.activeListingCount.toLocaleString('ja-JP')} 点</dd>
                <dt>{COPY.columnOrders}</dt>
                <dd>{row.orderCount.toLocaleString('ja-JP')} 件</dd>
                <dt>{COPY.columnGross}</dt>
                <dd>{row.grossAmount.toLocaleString('ja-JP')} 円</dd>
                <dt>{COPY.columnRefunded}</dt>
                <dd>{formatSignedYen(row.refundedAmount)}</dd>
                <dt>{COPY.columnLastSold}</dt>
                <dd>{row.lastSoldAt === null ? '—' : formatDateTime(row.lastSoldAt)}</dd>
              </dl>
            </li>
          ))}
        </ul>
      )}

      <p className="sengoku-form__hint">{COPY.salesTermsHint}</p>
    </>
  );
}
