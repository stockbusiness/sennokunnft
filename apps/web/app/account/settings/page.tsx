import { Notice, PageHeader } from '@sengoku/ui';
import { isLoggedIn } from '../../../src/auth/current';
import { LOGIN_COPY } from '../../../src/auth/copy';
import { ACCOUNT_COPY } from '../../../src/account-copy';

/**
 * 設定（P0-3）。
 *
 * ⚠️ **いま変えられることだけを置く。** 「準備中」の項目を並べると、
 * 押しても何も起きない欄が増えるだけで、できることが見つけにくくなる。
 *
 * ⚠️ **メールアドレスの変更をここに置いていない。** 本人確認の範囲が
 * 未決（`UD-124`）で、確認なしに差し替えられる口を作ると、乗っ取った側が
 * 連絡先ごと奪える。運営への申請という形にする（P1-1）。
 */
export default async function AccountSettingsPage() {
  const loggedIn = await isLoggedIn();

  return (
    <>
      <PageHeader
        title={ACCOUNT_COPY.settingsTitle}
        description={ACCOUNT_COPY.settingsDescription}
      />

      <section className="sengoku-panel">
        <h2 className="sengoku-panel__title">{ACCOUNT_COPY.walletTitle}</h2>
        {/*
          ⚠️ **ここで登録状況を断定しない。** 受取用のウォレットの結び付きは
             外部（共通顧客ID）の解決を待つもので、画面が「未登録です」と
             言い切ると、解決待ちの方に誤った案内をする。
          ⚠️ 登録していない方を責める言い方にしない。登録は任意で、
             していなくてもお受け取りいただける。
        */}
        <Notice
          title={ACCOUNT_COPY.walletUnregisteredNotice}
          hint={ACCOUNT_COPY.walletUnregisteredHint}
        />
        <p className="sengoku-form__hint">{ACCOUNT_COPY.walletRegisteredHint}</p>
      </section>

      <section className="sengoku-panel">
        <h2 className="sengoku-panel__title">{ACCOUNT_COPY.supportTitle}</h2>
        <p className="sengoku-form__hint">{ACCOUNT_COPY.supportHint}</p>
        {/* ⚠️ 連絡先そのものを書かない。法務文書が正。 */}
        <p>
          <a href="/legal/tokushoho">{ACCOUNT_COPY.supportLink}</a>
        </p>
      </section>

      {loggedIn ? (
        <form className="sengoku-logout" method="post" action="/api/auth/logout">
          {/* ⚠️ GET にしない。リンクを踏ませるだけで他人をログアウトさせられる。 */}
          <button className="sengoku-button sengoku-button--quiet" type="submit">
            {LOGIN_COPY.logout}
          </button>
        </form>
      ) : null}

      <p className="sengoku-back-link">
        <a href="/account">{ACCOUNT_COPY.backToAccount}</a>
      </p>
    </>
  );
}
