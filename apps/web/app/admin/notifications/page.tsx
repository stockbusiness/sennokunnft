import { NOTIFICATION_EVENT_TYPE_VALUES, NOTIFICATION_STATUS_VALUES } from '@sengoku/contracts';
import { EmptyState, Notice, PageHeader, StatusBadge } from '@sengoku/ui';
import { fetchNotificationHistory } from '../../../src/admin-client';
import { ADMIN_COPY } from '../../../src/admin-copy';
import {
  OPERATIONS_COPY,
  formatJst,
  notificationEventLabel,
  notificationStatusLabel,
  notificationStatusTone,
} from '../../../src/operations-copy';
import { ResendNotificationForm } from './forms';

/**
 * 知らせの送信履歴（実運営 指示書 P0-4 / P0-6）。
 *
 * ⚠️ **宛先を伏せた表記しか出さない。** `t*****@e******.jp` から元へは
 * 戻せない。API もそれしか持っていない（`UD-503`）。
 *
 * ⚠️ **本文を出さない。** 差し込んだあとの本文には、ご注文の内容が入る。
 * 履歴として残すのは「いつ・どの種別を・どの宛先へ」まで。
 *
 * ⚠️ **`送信済み` を「届いた」と読ませない。** 送信事業者が受け付けた
 * ところまでしか、こちらには分からない。
 */
export default async function AdminNotificationsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const status = toSingle(params.status);
  const eventType = toSingle(params.eventType);
  const cursor = toSingle(params.cursor);

  const filter = { status, eventType, cursor };
  const result = await fetchNotificationHistory(compact(filter));

  if (!result.ok) {
    return (
      <>
        <PageHeader title={OPERATIONS_COPY.notificationsTitle} />
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
        title={OPERATIONS_COPY.notificationsTitle}
        description="買った方へお送りした知らせの記録です。送れなかったものは、理由を確かめてから送り直せます。"
      />

      <Notice
        tone="info"
        title="宛先は伏せた形でお見せしています。"
        hint="「送信済み」は、送信事業者がお預かりしたところまでです。相手先へ届いたことまでは分かりません。"
      />

      <form className="sengoku-form" method="get">
        <div className="sengoku-form__field">
          <label className="sengoku-form__label" htmlFor="notification-status">
            状態
          </label>
          <select
            className="sengoku-form__input"
            id="notification-status"
            name="status"
            defaultValue={status ?? ''}
          >
            <option value="">すべて</option>
            {NOTIFICATION_STATUS_VALUES.map((value) => (
              <option key={value} value={value}>
                {notificationStatusLabel(value)}
              </option>
            ))}
          </select>
        </div>

        <div className="sengoku-form__field">
          <label className="sengoku-form__label" htmlFor="notification-event">
            知らせの種別
          </label>
          <select
            className="sengoku-form__input"
            id="notification-event"
            name="eventType"
            defaultValue={eventType ?? ''}
          >
            <option value="">すべて</option>
            {NOTIFICATION_EVENT_TYPE_VALUES.map((value) => (
              <option key={value} value={value}>
                {notificationEventLabel(value)}
              </option>
            ))}
          </select>
        </div>

        <div className="sengoku-actions">
          <button className="sengoku-button" type="submit">
            この条件で表示する
          </button>
          <a className="sengoku-button sengoku-button--quiet" href="/admin/notifications">
            条件を消す
          </a>
        </div>
      </form>

      {items.length === 0 ? (
        <EmptyState
          title="あてはまる知らせはありませんでした。"
          hint="条件をゆるめてお試しください。"
        />
      ) : (
        <div className="sengoku-table-scroll">
          <table className="sengoku-table sengoku-table--wide">
            <thead>
              <tr>
                <th scope="col">状態</th>
                <th scope="col">種別</th>
                <th scope="col">宛先</th>
                <th scope="col">件名</th>
                <th scope="col">試した回数</th>
                <th scope="col">理由</th>
                <th scope="col">送信</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <StatusBadge
                      label={notificationStatusLabel(item.status)}
                      tone={notificationStatusTone(item.status)}
                    />
                  </td>
                  <td>{notificationEventLabel(item.eventType)}</td>
                  {/*
                    ⚠️ 伏せた表記そのもの。ここから元のアドレスへは戻せない。
                  */}
                  <td className="sengoku-code-inline">{item.maskedRecipient ?? '—'}</td>
                  <td>{item.subject}</td>
                  <td className="sengoku-table__nowrap">{String(item.attemptCount)} 回</td>
                  <td className="sengoku-table__nowrap">
                    {item.lastErrorCode ?? item.skippedReasonCode ?? '—'}
                  </td>
                  <td className="sengoku-table__nowrap">{formatJst(item.sentAt)}</td>
                  <td>
                    {/*
                      ⚠️ 押せるのに何も起きないボタンを並べない。
                         送り直せるのは、送れなかったものだけ。
                    */}
                    {item.status === 'FAILED' || item.status === 'DEAD' ? (
                      <ResendNotificationForm deliveryId={item.id} />
                    ) : null}
                  </td>
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

/** 続きのリンク。⚠️ 絞り込みを引き継ぐ。 */
function nextHref(filter: Record<string, string | undefined>, cursor: string): string {
  const params = new URLSearchParams(compact(filter));
  params.set('cursor', cursor);
  return `/admin/notifications?${params.toString()}`;
}
