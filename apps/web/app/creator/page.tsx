import { EmptyState, Notice, PageHeader, StatusBadge } from '@sengoku/ui';
import { fetchMyArtworks } from '../../src/creator-client';
import { CREATOR_COPY, creatorErrorMessage } from '../../src/creator-copy';
import { artworkStatusLabel } from '../../src/admin-copy';
import { isLoggedIn } from '../../src/auth/current';
import { LOGIN_COPY } from '../../src/auth/copy';

export default async function CreatorHomePage() {
  const result = await fetchMyArtworks();
  const loggedIn = await isLoggedIn();

  return (
    <>
      <PageHeader title={CREATOR_COPY.listTitle} description={CREATOR_COPY.listDescription} />

      {/*
        ⚠️ ログインしていないときだけ「共有されている」と伝える。
           出しっぱなしにすると、ログイン済みの人に誤って伝わる。
      */}
      {loggedIn ? null : (
        <Notice
          tone="alert"
          title={CREATOR_COPY.sharedAccountNotice}
          hint={CREATOR_COPY.sharedAccountHint}
        />
      )}

      {loggedIn ? (
        <form className="sengoku-logout" method="post" action="/api/auth/logout">
          {/* ⚠️ GET にしない。リンクを踏ませるだけで他人をログアウトさせられる。 */}
          <button className="sengoku-button sengoku-button--quiet" type="submit">
            {LOGIN_COPY.logout}
          </button>
        </form>
      ) : null}

      <p className="sengoku-creator-actions">
        <a className="sengoku-button" href="/creator/artworks/new">
          {CREATOR_COPY.newLink}
        </a>
      </p>

      {!result.ok ? (
        <EmptyState title={creatorErrorMessage(result.reason)} hint="" />
      ) : result.data.items.length === 0 ? (
        <EmptyState title={CREATOR_COPY.noArtworks} hint={CREATOR_COPY.noArtworksHint} />
      ) : (
        <div className="sengoku-table-scroll">
          <table className="sengoku-table">
            <thead>
              <tr>
                <th scope="col">作品名</th>
                <th scope="col">状態</th>
                <th scope="col">残り / 全数</th>
                <th scope="col"> </th>
              </tr>
            </thead>
            <tbody>
              {result.data.items.map((artwork) => (
                <tr key={artwork.id}>
                  <td>{artwork.title}</td>
                  <td>
                    <StatusBadge
                      label={artworkStatusLabel(artwork.status)}
                      tone={artwork.status === 'published' ? 'success' : 'neutral'}
                    />
                  </td>
                  <td>
                    {artwork.availableSupply} / {artwork.maxSupply}
                  </td>
                  <td>
                    <a href={`/creator/artworks/${artwork.id}`}>編集する</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
