import { EmptyState, Notice, PageHeader, StatusBadge } from '@sengoku/ui';
import { fetchMyArtworks, fetchMyProfile } from '../../src/creator-client';
import { DisplayNameForm } from './profile-form';
import { CREATOR_COPY, creatorErrorMessage } from '../../src/creator-copy';
import { artworkStatusLabel } from '../../src/admin-copy';
import { isLoggedIn } from '../../src/auth/current';
import { LOGIN_COPY } from '../../src/auth/copy';

export default async function CreatorHomePage() {
  const [result, profile, loggedIn] = await Promise.all([
    fetchMyArtworks(),
    fetchMyProfile(),
    isLoggedIn(),
  ]);

  /*
    ⚠️ **読めなかったときは、フォームごと出さない。** 空欄を初期値にすると、
       登録済みの方が押した拍子に**別の名前へ書き換わる**。読めていないことと
       「登録されていない」ことは違う。
  */
  const displayName = profile.ok ? profile.data.displayName : null;

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

      {/*
        お名前。⚠️ **作品の一覧より前に置く。** 作品ページに出るので、
        並べる前に決めていただくほうがよい。
      */}
      <section className="sengoku-panel">
        <h2 className="sengoku-panel__title">{CREATOR_COPY.profileTitle}</h2>
        <p className="sengoku-form__hint">{CREATOR_COPY.profileDescription}</p>
        {!profile.ok ? (
          <Notice tone="alert" title={creatorErrorMessage(profile.reason, profile.code)} />
        ) : (
          <>
            {displayName === null ? (
              <Notice
                title={CREATOR_COPY.displayNameMissingNotice}
                hint={CREATOR_COPY.displayNameMissingHint}
              />
            ) : null}
            <DisplayNameForm current={displayName} />
          </>
        )}
      </section>

      <p className="sengoku-creator-actions">
        <a className="sengoku-button" href="/creator/artworks/new">
          {CREATOR_COPY.newLink}
        </a>
      </p>

      {/*
        ⚠️ **売上とお店の情報を、作品の一覧と同じ高さに置く。** 作家さまが
           いちばん確かめたいのは「売れたか」である。奥に隠さない。
      */}
      <p className="sengoku-creator-actions">
        <a className="sengoku-button sengoku-button--quiet" href="/creator/earnings">
          {CREATOR_COPY.earningsTitle}
        </a>{' '}
        <a className="sengoku-button sengoku-button--quiet" href="/creator/shop">
          {CREATOR_COPY.shopTitle}
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
