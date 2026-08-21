import { Notice, PageHeader, StatusBadge } from '@sengoku/ui';
import { fetchMyPayoutAccount, fetchMyProfileDetail } from '../../../src/creator-client';
import { CREATOR_COPY, creatorErrorMessage } from '../../../src/creator-copy';
import { formatJst } from '../../../src/customer-copy';
import { PayoutAccountForm } from '../payout-account-form';
import { ShopProfileForm } from '../shop-form';

/**
 * お店の情報とご準備の状況（実運営 指示書 P1-2）。
 *
 * ⚠️ **お振込先はこの画面で登録する**（P1-3・`UD-124` 決定 2026-08-21）。
 * 本人確認書類は取らない——**取らないと決めたものは、入力欄も作らない**。
 *
 * ⚠️ **ここで「売らせない」判定をしない。** ご準備の状況は案内であって、
 * 門ではない。門にすると、判定が画面と API の 2 か所に分かれる。
 */
export default async function CreatorShopPage() {
  const [profile, payoutAccount] = await Promise.all([
    fetchMyProfileDetail(),
    fetchMyPayoutAccount(),
  ]);

  if (!profile.ok) {
    return (
      <>
        <PageHeader title={CREATOR_COPY.shopTitle} description={CREATOR_COPY.shopDescription} />
        {/*
          ⚠️ **読めなかったときは、フォームごと出さない。** 空欄を初期値に
             すると、登録済みの方が押した拍子に**全部消える**。
        */}
        <Notice tone="alert" title={creatorErrorMessage(profile.reason, profile.code)} />
        <p className="sengoku-creator-actions">
          <a href="/creator">{CREATOR_COPY.backToList}</a>
        </p>
      </>
    );
  }

  const detail = profile.data;

  return (
    <>
      <PageHeader title={CREATOR_COPY.shopTitle} description={CREATOR_COPY.shopDescription} />

      {/* --- ご準備の状況 --- */}
      <section className="sengoku-panel">
        <h2 className="sengoku-panel__title">{CREATOR_COPY.setupTitle}</h2>
        <ul className="sengoku-setup">
          {detail.setup.map((step) => (
            <li className="sengoku-setup__item" key={step.key}>
              <p className="sengoku-setup__label">
                <span>{step.label}</span>
                {/* ⚠️ 色だけで伝えない。「済」「これから」と書く。 */}
                <StatusBadge
                  label={step.done ? CREATOR_COPY.setupDone : CREATOR_COPY.setupTodo}
                  tone={step.done ? 'success' : 'neutral'}
                />
                {/* ⚠️ 任意のものは、任意だと書く。急かさない。 */}
                {step.required ? null : <StatusBadge label={CREATOR_COPY.setupOptional} />}
              </p>
              <p className="sengoku-setup__detail">{step.detail}</p>
            </li>
          ))}
        </ul>
      </section>

      {/* --- 販売規約 --- */}
      <section className="sengoku-panel">
        <h2 className="sengoku-panel__title">{CREATOR_COPY.salesTermsTitle}</h2>
        {detail.salesTermsAcceptedAt === null ? (
          <Notice
            title={CREATOR_COPY.salesTermsPending}
            hint={CREATOR_COPY.salesTermsPendingHint}
          />
        ) : (
          <p>{`${formatJst(detail.salesTermsAcceptedAt)} にご同意いただいています。`}</p>
        )}
      </section>

      {/* --- お振込先（P1-3・`UD-124` 決定 2026-08-21）--- */}
      <section className="sengoku-panel">
        <h2 className="sengoku-panel__title">{CREATOR_COPY.payoutAccountTitle}</h2>
        <p className="sengoku-form__hint">{CREATOR_COPY.payoutAccountDescription}</p>

        {!payoutAccount.ok ? (
          /*
            ⚠️ **読めなかったときは、フォームごと出さない。** 空欄を初期値に
               すると、登録済みの方が押した拍子に**別の口座へ書き換わる**。
               お金の行き先が変わるので、いちばん危ない取り違えである。
          */
          <Notice
            tone="alert"
            title={CREATOR_COPY.payoutAccountUnavailable}
            hint={CREATOR_COPY.payoutAccountUnavailableHint}
          />
        ) : (
          <>
            {payoutAccount.data.account === null ? (
              <Notice
                title={CREATOR_COPY.payoutAccountMissing}
                hint={CREATOR_COPY.payoutAccountMissingHint}
              />
            ) : null}
            <PayoutAccountForm current={payoutAccount.data.account} />
          </>
        )}
      </section>

      {/* --- お店の情報 --- */}
      <section className="sengoku-panel">
        <h2 className="sengoku-panel__title">{CREATOR_COPY.shopTitle}</h2>
        {/*
          ⚠️ **お名前はここで変えない。** `/creator` の「お名前」で扱う。
             同じ画面に 2 つの保存口があると、どちらが効いたか分からない。
        */}
        <p className="sengoku-form__hint">
          {`作品ページに出るお名前は「${detail.displayName ?? CREATOR_COPY.displayNameUnset}」です。変更は出品の画面から行えます。`}
        </p>
        <ShopProfileForm current={detail} />
      </section>

      <p className="sengoku-creator-actions">
        <a href="/creator">{CREATOR_COPY.backToList}</a>
      </p>
    </>
  );
}
