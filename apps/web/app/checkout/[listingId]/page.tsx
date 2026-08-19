import { randomUUID } from 'node:crypto';
import { notFound } from 'next/navigation';
import { EmptyState, Notice, PageHeader, PriceTag } from '@sengoku/ui';
import { checkoutNoticeFrom, CHECKOUT_NOTICE_FIELD_KEYS } from '@sengoku/contracts';
import { fetchLegalDocument, fetchPublicListing } from '../../../src/api-client';
import { LEGAL_COPY, TOKUSHOHO_LABEL } from '../../../src/legal-copy';
import { isLoggedIn } from '../../../src/auth/current';
import { ORDER_COPY } from '../../../src/order-copy';
import { CheckoutForm } from './forms';

/**
 * ご注文内容の確認（指示書 §8）。
 *
 * ⚠️ **押した瞬間に注文が立つ画面なので、静的化させない。**
 * 在庫と販売状態は刻々と変わる。焼き付いた画面から申し込むと、
 * 売り切れた作品に「お申し込みいただけます」と出続ける。
 */
export const dynamic = 'force-dynamic';

export default async function CheckoutPage({ params }: { params: Promise<{ listingId: string }> }) {
  const { listingId } = await params;
  const result = await fetchPublicListing(listingId);

  if (!result.ok) {
    if (result.reason === 'not_found') {
      notFound();
    }
    return (
      <>
        <PageHeader title={ORDER_COPY.checkoutTitle} />
        <EmptyState title={ORDER_COPY.retryTitle} hint={ORDER_COPY.retryHint} />
      </>
    );
  }

  const listing = result.data;

  /*
    ⚠️ **売り切れ・販売停止は、ログインより先に見る。**
    先にログインへ送ると、ログインし終えてから「買えません」と言うことになる。
    手間をかけさせたうえで断るのは、いちばん人を怒らせる順序。
  */
  if (listing.displayState !== 'on_sale' || listing.availableSupply <= 0) {
    return (
      <>
        <PageHeader title={ORDER_COPY.checkoutTitle} />
        <EmptyState title={ORDER_COPY.soldOutTitle} hint={ORDER_COPY.soldOutHint} />
        <p className="sengoku-back-link">
          <a href={`/artworks/${listing.artworkSlug}`}>← {ORDER_COPY.backToCatalog}</a>
        </p>
      </>
    );
  }

  /*
    お申し込みの条件（特商法12条の6）。

    ⚠️ **「特商法のページを見てください」では足りない。** 通信販売では
       申込みの**最終確認画面そのもの**に出す必要がある。とくに返品特約は、
       ここに出していないとこちらの条件が効かず、法定の解除権が適用される。

    ⚠️ **掲げられないなら、申し込ませない。** API 側でも支払い口を
       作らせないが、画面でも先に止める。押せるのに断られる形にすると、
       手間をかけさせてから断ることになる。
  */
  const tokushoho = await fetchLegalDocument('tokushoho');
  const notice = tokushoho.ok
    ? checkoutNoticeFrom(tokushoho.data.version?.tokushoho ?? null)
    : null;
  if (notice === null) {
    return (
      <>
        <PageHeader title={ORDER_COPY.checkoutTitle} />
        <EmptyState
          title={LEGAL_COPY.checkoutTermsUnavailable}
          hint={LEGAL_COPY.checkoutTermsUnavailableHint}
        />
        <p className="sengoku-back-link">
          <a href={`/artworks/${listing.artworkSlug}`}>← {ORDER_COPY.backToCatalog}</a>
        </p>
      </>
    );
  }

  if (!(await isLoggedIn())) {
    return (
      <>
        <PageHeader title={ORDER_COPY.checkoutTitle} />
        <Notice
          tone="info"
          title={ORDER_COPY.loginRequiredTitle}
          hint={ORDER_COPY.loginRequiredHint}
        />
        <p className="sengoku-back-link">
          <a className="sengoku-button" href="/login">
            {ORDER_COPY.loginLink}
          </a>
        </p>
      </>
    );
  }

  /*
    重複防止キーはここで 1 回だけ作る。

    ⚠️ **ブラウザ側で作らない。** 再描画のたびに別のキーになると、
       二度押しが二重注文になる。サーバー側で作って hidden で渡すと、
       同じ画面から何度送っても同じキーになる。
    ⚠️ **`Math.random()` を使わない。** 他人のキーを当てられる形にしない。
  */
  const idempotencyKey = randomUUID();

  return (
    <>
      <PageHeader title={ORDER_COPY.checkoutTitle} description={ORDER_COPY.checkoutDescription} />

      <dl className="sengoku-facts">
        <dt>{ORDER_COPY.checkoutItemHeading}</dt>
        <dd>{listing.artworkTitle}</dd>
        <dt>{ORDER_COPY.checkoutQuantityLabel}</dt>
        <dd>{ORDER_COPY.checkoutQuantityValue}</dd>
        <dt>{ORDER_COPY.checkoutPriceLabel}</dt>
        <dd>
          <PriceTag price={listing.price} />
        </dd>
      </dl>

      {/*
        お申し込みの条件（特商法12条の6）。
        ⚠️ **たたんで隠さない。** 開かないと読めない形にすると、
           「表示した」と言えるかどうかが怪しくなる。
      */}
      <section className="sengoku-checkout-terms">
        <h2>{LEGAL_COPY.checkoutTermsHeading}</h2>
        <dl className="sengoku-legal__fields">
          {CHECKOUT_NOTICE_FIELD_KEYS.map((key) => (
            <div key={key}>
              <dt>{TOKUSHOHO_LABEL[key] ?? key}</dt>
              <dd>{notice[key]}</dd>
            </div>
          ))}
        </dl>
        <p className="sengoku-form__hint">
          <a href="/legal/tokushoho" target="_blank" rel="noreferrer">
            {LEGAL_COPY.checkoutTermsFull}
          </a>
          {' ／ '}
          <a href="/legal/terms" target="_blank" rel="noreferrer">
            {LEGAL_COPY.checkoutTermsTerms}
          </a>
        </p>
      </section>

      {/*
        ⚠️ 「買えました」と読める言葉を置かない。この時点ではまだ
           お支払いが済んでいない。済んだと思われると、あとで督促になる。
      */}
      <Notice
        tone="info"
        title={ORDER_COPY.checkoutReserveNote}
        hint={ORDER_COPY.checkoutReserveHint}
      />

      <CheckoutForm listingId={listing.id} idempotencyKey={idempotencyKey} />

      <p className="sengoku-back-link">
        <a href={`/artworks/${listing.artworkSlug}`}>← {ORDER_COPY.backToCatalog}</a>
      </p>
    </>
  );
}
