import { EmptyState, Notice, PageHeader, StatusBadge } from '@sengoku/ui';
import { fetchEntitlements } from '../../../src/admin-client';
import { ADMIN_COPY } from '../../../src/admin-copy';
import {
  OPERATIONS_COPY,
  entitlementStatusLabel,
  formatJst,
  walletDeliveryLabel,
} from '../../../src/operations-copy';

/**
 * 受取権の一覧（実運営 指示書 P0-6）。
 *
 * ⚠️ **お名前もメールも出さない。** API がそもそも返さない（`UD-503`）。
 * 誰のものかを辿るときは、注文番号から注文の画面へ回る。
 *
 * ⚠️ **お受け取りの合言葉を出さない。** 一覧に載せると、画面を見られた
 * だけで他人が受け取れてしまう。API は照合値しか持っていない。
 *
 * ⚠️ **スマホ操作前提。** 表は横スクロールに倒す。
 */
const STATUS_CHOICES = [
  { value: '', label: 'すべて' },
  { value: 'issued', label: 'お受け取り前' },
  { value: 'claimed', label: 'お受け取り済み' },
  { value: 'revoked', label: '取り消し済み' },
] as const;

const DELIVERY_CHOICES = [
  { value: '', label: 'すべて' },
  { value: 'not_started', label: '未着手' },
  { value: 'pending', label: 'お届け中' },
  { value: 'delivered', label: 'お届け済み' },
] as const;

export default async function AdminEntitlementsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const status = toSingle(params.status);
  const walletDeliveryStatus = toSingle(params.walletDeliveryStatus);
  const orderId = toSingle(params.orderId);
  const cursor = toSingle(params.cursor);

  const filter = { status, walletDeliveryStatus, orderId, cursor };
  const result = await fetchEntitlements(compact(filter));

  if (!result.ok) {
    return (
      <>
        <PageHeader title={OPERATIONS_COPY.entitlementsTitle} />
        <EmptyState
          title={ADMIN_COPY.unavailableTitle(result.reason)}
          hint={ADMIN_COPY.unavailableHint}
        />
      </>
    );
  }

  const { items, nextCursor } = result.data;

  return (
    <>
      <PageHeader
        title={OPERATIONS_COPY.entitlementsTitle}
        description="お買い上げいただいた品をお渡しするための記録です。発行し直す・送り直すは、それぞれの詳細から行えます。"
      />

      <Notice
        tone="info"
        title="お名前・メールアドレスはここには出ません。"
        hint="どなたのご注文かを確かめるときは、注文番号から注文の画面へお進みください。"
      />

      <form className="sengoku-form" method="get">
        <div className="sengoku-form__field">
          <label className="sengoku-form__label" htmlFor="entitlement-status">
            受取権の状態
          </label>
          <select
            className="sengoku-form__input"
            id="entitlement-status"
            name="status"
            defaultValue={status ?? ''}
          >
            {STATUS_CHOICES.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </div>

        <div className="sengoku-form__field">
          <label className="sengoku-form__label" htmlFor="entitlement-delivery">
            ウォレットへのお届け
          </label>
          <select
            className="sengoku-form__input"
            id="entitlement-delivery"
            name="walletDeliveryStatus"
            defaultValue={walletDeliveryStatus ?? ''}
          >
            {DELIVERY_CHOICES.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </div>

        <div className="sengoku-form__field">
          <label className="sengoku-form__label" htmlFor="entitlement-order">
            ご注文の識別子
          </label>
          <input
            className="sengoku-form__input"
            id="entitlement-order"
            name="orderId"
            type="text"
            autoComplete="off"
            defaultValue={orderId ?? ''}
          />
        </div>

        <div className="sengoku-actions">
          <button className="sengoku-button" type="submit">
            この条件で表示する
          </button>
          <a className="sengoku-button sengoku-button--quiet" href="/admin/entitlements">
            条件を消す
          </a>
        </div>
      </form>

      {items.length === 0 ? (
        <EmptyState
          title="あてはまる受取権はありませんでした。"
          hint="条件をゆるめてお試しください。"
        />
      ) : (
        <div className="sengoku-table-scroll">
          <table className="sengoku-table sengoku-table--wide">
            <thead>
              <tr>
                <th scope="col">状態</th>
                <th scope="col">お届け</th>
                <th scope="col">ご注文</th>
                <th scope="col">作品</th>
                <th scope="col">番号</th>
                <th scope="col">お受け取り</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <StatusBadge label={entitlementStatusLabel(item.status)} />
                  </td>
                  <td>
                    <StatusBadge label={walletDeliveryLabel(item.walletDeliveryStatus)} />
                  </td>
                  <td className="sengoku-table__nowrap">
                    <a href={`/admin/entitlements/${encodeURIComponent(item.id)}`}>
                      {item.orderNumber}
                    </a>
                  </td>
                  <td>{item.artworkTitle}</td>
                  <td className="sengoku-table__nowrap">第 {String(item.serialNo)} 番</td>
                  <td className="sengoku-table__nowrap">{formatJst(item.claimedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {nextCursor === null ? null : (
        <p>
          <a className="sengoku-button sengoku-button--quiet" href={nextHref(filter, nextCursor)}>
            続きを表示する
          </a>
        </p>
      )}
    </>
  );
}

function toSingle(value: string | string[] | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Array.isArray(value) ? value[0] : value;
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

/** 続きのリンク。⚠️ 絞り込みを引き継ぐ。外すと 2 ページ目から条件が消える。 */
function nextHref(filter: Record<string, string | undefined>, cursor: string): string {
  const params = new URLSearchParams(compact(filter));
  params.set('cursor', cursor);
  return `/admin/entitlements?${params.toString()}`;
}
