import {
  ORDER_STATUS_VALUES,
  ORDER_PAYMENT_STATUS_VALUES,
  type AdminOrderView,
} from '@sengoku/contracts';
import { EmptyState, Notice, PageHeader } from '@sengoku/ui';
import { fetchAdminOrders } from '../../../src/admin-client';
import { ADMIN_COPY } from '../../../src/admin-copy';
import { ORDER_COPY, orderStatusLabel, paymentStatusLabel } from '../../../src/order-copy';
import { AdminOrderCard } from './order-card';
import { EmailLookupForm } from './search-form';

/**
 * 注文の一覧と検索（指示書 §9.1・`UD-121`）。
 *
 * ⚠️ **読むだけの画面にしてある。** 金額の書換え・お支払い済みへの変更・
 * 削除は API 側に無い（指示書 §9.3）。画面にボタンだけ置くと、
 * 押しても動かない操作が残り、いつか「動くように直そう」と言われる。
 *
 * ⚠️ **絞り込みは `GET` で URL に載せる。** 控えて共有でき、戻るボタンでも
 * 消えない。**ただしメールアドレスだけは載せない**（`UD-503`）——
 * 問い合わせ文字列はアクセスログとブラウザ履歴に残るため、
 * そちらは `EmailLookupForm` が本文で送る。
 */
export default async function AdminOrdersPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const query = {
    orderNumber: one(params.orderNumber),
    createdFrom: one(params.createdFrom),
    createdTo: one(params.createdTo),
    minTotalAmount: one(params.minTotalAmount),
    maxTotalAmount: one(params.maxTotalAmount),
    artworkTitle: one(params.artworkTitle),
    status: one(params.status),
    paymentStatus: one(params.paymentStatus),
  };
  const searching = Object.values(query).some((value) => value !== '');

  const result = await fetchAdminOrders({ limit: 50, ...query });

  return (
    <>
      <PageHeader title={ORDER_COPY.adminTitle} description={ORDER_COPY.adminDescription} />

      <Notice
        tone="info"
        title={ORDER_COPY.adminReadOnlyTitle}
        hint={ORDER_COPY.adminReadOnlyHint}
      />

      <SearchForm query={query} />
      <EmailLookupForm />

      {!result.ok ? (
        <EmptyState
          title={ADMIN_COPY.unavailableTitle(result.reason)}
          hint={ADMIN_COPY.unavailableHint}
        />
      ) : (
        <Results items={result.data.items} searching={searching} />
      )}
    </>
  );
}

function Results({
  items,
  searching,
}: {
  readonly items: readonly AdminOrderView[];
  readonly searching: boolean;
}) {
  if (items.length === 0) {
    /*
      ⚠️ **「まだ注文がありません」と「条件に合いません」を分ける。**
         同じ文言にすると、絞り込んだまま「1 件も売れていない」と
         読み違える。実際に起きる読み違いで、しかも気づけない。
    */
    return searching ? (
      <EmptyState title={ORDER_COPY.searchNoHits} hint={ORDER_COPY.searchNoHitsHint} />
    ) : (
      <EmptyState title={ORDER_COPY.adminNoOrders} hint={ORDER_COPY.adminNoOrdersHint} />
    );
  }

  return (
    <ul className="sengoku-order-list">
      {items.map((order) => (
        <AdminOrderCard key={order.id} order={order} />
      ))}
    </ul>
  );
}

/**
 * 絞り込みの入力欄。
 *
 * ⚠️ **`method="get"` である。** サーバーアクションにしないのは、
 * 条件を URL に残して控え・共有・戻るを効かせたいため。
 * ⚠️ **ここにメールアドレスの欄を足さない。** 足した瞬間に URL へ載る。
 * ⚠️ 日付は**日付だけ**を送る。その日の始まり／終わりの解釈は API 側に
 * 1 か所だけ置く（JST で区切る）。画面でも解釈すると必ずずれる。
 */
function SearchForm({ query }: { readonly query: Record<string, string> }) {
  return (
    <section className="sengoku-panel">
      <h2 className="sengoku-panel__title">{ORDER_COPY.searchHeading}</h2>
      <p className="sengoku-form__hint">{ORDER_COPY.searchHint}</p>

      <form className="sengoku-form" method="get" action="/admin/orders">
        <div className="sengoku-form__field">
          <label className="sengoku-form__label" htmlFor="order-search-number">
            {ORDER_COPY.searchOrderNumber}
          </label>
          <p className="sengoku-form__hint">{ORDER_COPY.searchOrderNumberHint}</p>
          <input
            className="sengoku-form__input"
            id="order-search-number"
            name="orderNumber"
            type="text"
            defaultValue={query.orderNumber}
          />
        </div>

        <div className="sengoku-form__field">
          <label className="sengoku-form__label" htmlFor="order-search-from">
            {ORDER_COPY.searchCreatedFrom}
          </label>
          <input
            className="sengoku-form__input"
            id="order-search-from"
            name="createdFrom"
            type="date"
            defaultValue={query.createdFrom}
          />
        </div>

        <div className="sengoku-form__field">
          <label className="sengoku-form__label" htmlFor="order-search-to">
            {ORDER_COPY.searchCreatedTo}
          </label>
          <input
            className="sengoku-form__input"
            id="order-search-to"
            name="createdTo"
            type="date"
            defaultValue={query.createdTo}
          />
        </div>

        <div className="sengoku-form__field">
          <label className="sengoku-form__label" htmlFor="order-search-min">
            {ORDER_COPY.searchMinAmount}
          </label>
          {/* ⚠️ 金額は円の整数。小数を打てないよう `step` を 1 にする。 */}
          <input
            className="sengoku-form__input"
            id="order-search-min"
            name="minTotalAmount"
            type="number"
            min={0}
            step={1}
            defaultValue={query.minTotalAmount}
          />
        </div>

        <div className="sengoku-form__field">
          <label className="sengoku-form__label" htmlFor="order-search-max">
            {ORDER_COPY.searchMaxAmount}
          </label>
          <input
            className="sengoku-form__input"
            id="order-search-max"
            name="maxTotalAmount"
            type="number"
            min={0}
            step={1}
            defaultValue={query.maxTotalAmount}
          />
        </div>

        <div className="sengoku-form__field">
          <label className="sengoku-form__label" htmlFor="order-search-title">
            {ORDER_COPY.searchArtworkTitle}
          </label>
          <input
            className="sengoku-form__input"
            id="order-search-title"
            name="artworkTitle"
            type="text"
            defaultValue={query.artworkTitle}
          />
        </div>

        <div className="sengoku-form__field">
          <label className="sengoku-form__label" htmlFor="order-search-status">
            {ORDER_COPY.searchStatus}
          </label>
          <select
            className="sengoku-form__input"
            id="order-search-status"
            name="status"
            defaultValue={query.status}
          >
            <option value="">{ORDER_COPY.searchAnyStatus}</option>
            {ORDER_STATUS_VALUES.map((value) => (
              <option key={value} value={value}>
                {orderStatusLabel(value)}
              </option>
            ))}
          </select>
        </div>

        <div className="sengoku-form__field">
          <label className="sengoku-form__label" htmlFor="order-search-payment">
            {ORDER_COPY.searchPaymentStatus}
          </label>
          <select
            className="sengoku-form__input"
            id="order-search-payment"
            name="paymentStatus"
            defaultValue={query.paymentStatus}
          >
            <option value="">{ORDER_COPY.searchAnyStatus}</option>
            {ORDER_PAYMENT_STATUS_VALUES.map((value) => (
              <option key={value} value={value}>
                {paymentStatusLabel(value)}
              </option>
            ))}
          </select>
        </div>

        <button className="sengoku-button" type="submit">
          {ORDER_COPY.searchSubmit}
        </button>
        <a className="sengoku-button sengoku-button--quiet" href="/admin/orders">
          {ORDER_COPY.searchClear}
        </a>
      </form>
    </section>
  );
}

function one(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    // ⚠️ 同じ名前が 2 回来たら先頭だけ使う。連結すると条件が化ける。
    return value[0] ?? '';
  }
  return value ?? '';
}
