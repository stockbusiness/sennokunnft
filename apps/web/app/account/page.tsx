import { EmptyState, Notice, PageHeader } from '@sengoku/ui';
import { fetchMyCollectibles, fetchMyOrders } from '../../src/order-client';
import { ACCOUNT_COPY, nextStepFor } from '../../src/account-copy';

/**
 * マイページの入口（P0-3）。
 *
 * ⚠️ **次にしていただくことを、画面の上に 1 つだけ置く**（指示書 §6）。
 * 複数並べると、どれから手を付ければよいのか分からなくなる。
 */
export default async function AccountHomePage() {
  const [orders, collectibles] = await Promise.all([fetchMyOrders(), fetchMyCollectibles()]);

  if (!orders.ok && orders.reason === 'unauthenticated') {
    // ⚠️ 中身を見せずにログインへ送る。何件あるかも漏らさない。
    return (
      <Notice
        title="ログインが必要です"
        hint="ご注文の確認には、ご登録のメールアドレスでのログインが必要です。"
      />
    );
  }

  const orderItems = orders.ok ? orders.data.items : [];
  const next = nextStepFor(orderItems);

  return (
    <>
      <PageHeader title={ACCOUNT_COPY.homeTitle} description={ACCOUNT_COPY.homeDescription} />

      {/* ⚠️ いちばん上。ここに置くのは常に 1 つだけ。 */}
      {next === null ? null : <Notice tone="alert" title={next.title} hint={next.hint} />}
      {next?.href === undefined ? null : (
        <p className="sengoku-creator-actions">
          <a className="sengoku-button" href={next.href}>
            {next.linkLabel ?? ACCOUNT_COPY.detailLink}
          </a>
        </p>
      )}

      {!orders.ok ? (
        <Notice
          tone="alert"
          title="ご注文の履歴を読み込めませんでした"
          hint="しばらくしてから、もう一度お試しください。"
        />
      ) : orderItems.length === 0 ? (
        <EmptyState title={ACCOUNT_COPY.noOrders} hint={ACCOUNT_COPY.noOrdersHint} />
      ) : (
        <dl className="sengoku-facts">
          <dt>{ACCOUNT_COPY.toOrders}</dt>
          <dd>
            {orderItems.length} 件 <a href="/account/orders">（一覧を見る）</a>
          </dd>
          <dt>{ACCOUNT_COPY.toCollectibles}</dt>
          <dd>
            {collectibles.ok ? `${collectibles.data.items.length} 点` : '—'}{' '}
            <a href="/account/collectibles">（一覧を見る）</a>
          </dd>
        </dl>
      )}

      <section className="sengoku-panel">
        <h2 className="sengoku-panel__title">{ACCOUNT_COPY.supportTitle}</h2>
        <p className="sengoku-form__hint">{ACCOUNT_COPY.supportHint}</p>
        {/* ⚠️ 連絡先そのものを書かない。法務文書が正。 */}
        <p>
          <a href="/legal/tokushoho">{ACCOUNT_COPY.supportLink}</a>
        </p>
      </section>
    </>
  );
}
