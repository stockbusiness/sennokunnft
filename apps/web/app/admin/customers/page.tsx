import { EmptyState, Notice, PageHeader, StatusBadge } from '@sengoku/ui';
import { searchCustomers } from '../../../src/admin-client';
import { ADMIN_COPY } from '../../../src/admin-copy';
import {
  CUSTOMER_COPY,
  accountStatusLabel,
  formatJst,
  formatYen,
  shortId,
} from '../../../src/customer-copy';

/**
 * お客さまを探す（実運営 指示書 P1-1）。
 *
 * ⚠️ **条件無しの一覧を作らない。** 顧客をただ眺められる画面は業務に
 * 要らないうえに、漏れたときの被害がいちばん大きい。手がかりが無ければ
 * 何も出さない。
 *
 * ⚠️ **ご連絡先は `GET` の問い合わせに載せない。** URL に載せると、
 * アクセスログと履歴と Referer に残る。この画面の検索は Server Action
 * 経由（`POST`）で送る。
 */
export default async function AdminCustomersPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  /*
    ⚠️ **`GET` で受けるのは、アドレスを含まない手がかりだけ。**
       注文番号・共通顧客ID・アカウントIDは、それ自体が連絡先ではない。
       ご連絡先で探すときは下のフォームが `POST` で送る。
  */
  const orderNumber = toSingle(params.orderNumber);
  const commonUserId = toSingle(params.commonUserId);
  const accountId = toSingle(params.accountId);
  const hasCriteria =
    orderNumber !== undefined || commonUserId !== undefined || accountId !== undefined;

  const result = hasCriteria
    ? await searchCustomers(compact({ orderNumber, commonUserId, accountId }))
    : null;

  return (
    <>
      <PageHeader title={CUSTOMER_COPY.title} description={CUSTOMER_COPY.description} />

      <Notice
        tone="info"
        title="お名前とご連絡先は、この仕組みに保存されていません。"
        hint={CUSTOMER_COPY.searchHint}
      />

      <h2>{CUSTOMER_COPY.searchHeading}</h2>
      <form className="sengoku-form" method="get">
        <div className="sengoku-form__field">
          <label className="sengoku-form__label" htmlFor="customer-order-number">
            ご注文番号
          </label>
          <input
            className="sengoku-form__input"
            id="customer-order-number"
            name="orderNumber"
            type="text"
            autoComplete="off"
            defaultValue={orderNumber ?? ''}
          />
        </div>

        <div className="sengoku-form__field">
          <label className="sengoku-form__label" htmlFor="customer-common-user-id">
            共通顧客ID
          </label>
          <input
            className="sengoku-form__input"
            id="customer-common-user-id"
            name="commonUserId"
            type="text"
            autoComplete="off"
            defaultValue={commonUserId ?? ''}
          />
        </div>

        <div className="sengoku-form__field">
          <label className="sengoku-form__label" htmlFor="customer-account-id">
            アカウントID
          </label>
          <input
            className="sengoku-form__input"
            id="customer-account-id"
            name="accountId"
            type="text"
            autoComplete="off"
            defaultValue={accountId ?? ''}
          />
        </div>

        <div className="sengoku-actions">
          <button className="sengoku-button" type="submit">
            お探しする
          </button>
          <a className="sengoku-button sengoku-button--quiet" href="/admin/customers">
            条件を消す
          </a>
        </div>
      </form>

      {/*
        ⚠️ **ご連絡先での検索は注文の画面へ回す。** あちらは `POST` で
           受ける口をすでに持っている（`UD-121`）。同じ口を 2 つ作らない。
      */}
      <p className="sengoku-form__hint">
        ご連絡先からお探しになる場合は、
        <a href="/admin/orders">注文の画面</a>
        でご注文を特定してから、注文番号でこちらをお引きください。
      </p>

      {result === null ? (
        <EmptyState
          title={CUSTOMER_COPY.noCriteria}
          hint="お問い合わせのときに伺った番号を、上の欄へご入力ください。"
        />
      ) : !result.ok ? (
        <EmptyState
          title={ADMIN_COPY.unavailableTitle(result.reason)}
          hint={ADMIN_COPY.unavailableHint}
        />
      ) : result.data.items.length === 0 ? (
        <EmptyState title={CUSTOMER_COPY.notFound} hint="番号のお間違いがないかご確認ください。" />
      ) : (
        <div className="sengoku-table-scroll">
          <table className="sengoku-table sengoku-table--wide">
            <thead>
              <tr>
                <th scope="col">状態</th>
                <th scope="col">アカウント</th>
                <th scope="col">ご注文</th>
                <th scope="col">お支払い（返金差引後）</th>
                <th scope="col">お渡し</th>
                <th scope="col">直近のご注文</th>
              </tr>
            </thead>
            <tbody>
              {result.data.items.map((item) => (
                <tr key={item.accountId}>
                  <td>
                    <StatusBadge
                      label={accountStatusLabel(item.status)}
                      tone={item.status === 'suspended' ? 'danger' : 'neutral'}
                    />
                  </td>
                  <td className="sengoku-table__nowrap">
                    <a href={`/admin/customers/${encodeURIComponent(item.accountId)}`}>
                      {shortId(item.accountId)}
                    </a>
                  </td>
                  <td className="sengoku-table__nowrap">{String(item.orderCount)} 件</td>
                  {/* ⚠️ 画面で引き算をさせない。サーバー側で出した値をそのまま。 */}
                  <td className="sengoku-table__nowrap">{formatYen(item.netPaidAmount)}</td>
                  <td className="sengoku-table__nowrap">
                    {String(item.entitlementCount)} 点（未受取 {String(item.unclaimedCount)}）
                  </td>
                  <td className="sengoku-table__nowrap">{formatJst(item.lastOrderAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function toSingle(value: string | string[] | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const single = Array.isArray(value) ? value[0] : value;
  return single === '' ? undefined : single;
}

function compact(filter: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(filter)) {
    if (value !== undefined && value !== '') {
      out[key] = value;
    }
  }
  return out;
}
