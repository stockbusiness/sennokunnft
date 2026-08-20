import { EmptyState, Notice, PageHeader, StatusBadge } from '@sengoku/ui';
import { fetchWalletDeliveries } from '../../../src/admin-client';
import { ADMIN_COPY } from '../../../src/admin-copy';
import {
  DELIVERY_COPY,
  deliveryErrorLabel,
  deliveryStatusDescription,
  deliveryStatusLabel,
  deliveryStatusTone,
  formatDateTime,
} from '../../../src/delivery-copy';
import { BulkResendForm } from './forms';

/**
 * お届けの状況（管理画面・外部連携 指示書 §5）。
 *
 * ⚠️ **お届けした本文を出さない。** API がそもそも返さないので
 * 出しようが無い——という状態を保つ。画面に「出さない」と書いてあるのは、
 * 「見えるようにしてほしい」という要望が出たときに、理由ごと思い出せるようにするため。
 *
 * ⚠️ **スマホ操作前提。** 表は横スクロールに倒し、操作は指の幅で押せる大きさにする。
 */
const STATUS_CHOICES = [
  { value: 'DEAD', label: '何度試してもお届けできなかったもの' },
  { value: 'FAILED', label: 'お届けできなかったもの' },
  { value: 'PENDING', label: 'お届けを待っているもの' },
  { value: 'PROCESSING', label: 'お届けしているもの' },
  { value: 'DELIVERED', label: 'お届けできたもの' },
  // ⚠️ 再送の対象にならない。返金で取り消したため、届ける必要が無くなったもの。
  { value: 'SUPERSEDED', label: '取り消しにより送信が不要になったもの' },
] as const;

export default async function AdminWalletDeliveriesPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const statuses = toArray(params.status);
  const eventId = toSingle(params.eventId);
  const cursor = toSingle(params.cursor);

  const result = await fetchWalletDeliveries({ statuses, eventId, cursor });

  if (!result.ok) {
    return (
      <>
        <PageHeader title={DELIVERY_COPY.title} />
        <EmptyState
          title={ADMIN_COPY.unavailableTitle(result.reason)}
          hint={ADMIN_COPY.unavailableHint}
        />
      </>
    );
  }

  const { items, counts, nextCursor } = result.data;
  const resendable = items.filter((item) => item.canResend);

  return (
    <>
      <PageHeader title={DELIVERY_COPY.title} description={DELIVERY_COPY.description} />

      {/* ⚠️ 本文を出さない理由を、画面にも書く。 */}
      <Notice tone="info" title={DELIVERY_COPY.payloadNote} hint={DELIVERY_COPY.payloadNoteHint} />

      <h2>{DELIVERY_COPY.countsHeading}</h2>
      {/*
        ⚠️ **絞り込みと無関係の全体件数。** ここが絞り込みに引きずられると、
           「失敗だけ表示」した画面に「失敗 0 件」と出る。
      */}
      <dl className="sengoku-definition-list">
        {STATUS_CHOICES.map((choice) => (
          <div key={choice.value}>
            <dt>{deliveryStatusDescription(choice.value)}</dt>
            <dd>{String(counts[choice.value] ?? 0)} 件</dd>
          </div>
        ))}
      </dl>

      <h2>{DELIVERY_COPY.filterHeading}</h2>
      <form className="sengoku-form" method="get">
        <div className="sengoku-form__field">
          <span className="sengoku-form__label">{DELIVERY_COPY.filterStatus}</span>
          {STATUS_CHOICES.map((choice) => (
            <label className="sengoku-checkbox" key={choice.value}>
              <input
                type="checkbox"
                name="status"
                value={choice.value}
                defaultChecked={statuses.includes(choice.value)}
              />
              <span>{choice.label}</span>
            </label>
          ))}
        </div>

        <div className="sengoku-form__field">
          <label className="sengoku-form__label" htmlFor="delivery-event-id">
            {DELIVERY_COPY.filterEventId}
          </label>
          <p className="sengoku-form__hint">{DELIVERY_COPY.filterEventIdHint}</p>
          <input
            className="sengoku-form__input"
            id="delivery-event-id"
            name="eventId"
            type="text"
            autoComplete="off"
            defaultValue={eventId ?? ''}
          />
        </div>

        <div className="sengoku-actions">
          <button className="sengoku-button" type="submit">
            {DELIVERY_COPY.submitFilter}
          </button>
          <a className="sengoku-button sengoku-button--quiet" href="/admin/wallet-deliveries">
            {DELIVERY_COPY.submitClear}
          </a>
        </div>
      </form>

      {items.length === 0 ? (
        <EmptyState title={DELIVERY_COPY.noItems} hint={DELIVERY_COPY.noItemsHint} />
      ) : (
        <BulkResendForm>
          <div className="sengoku-table-scroll">
            <table className="sengoku-table sengoku-table--wide">
              <thead>
                <tr>
                  <th scope="col">{DELIVERY_COPY.selectLabel}</th>
                  <th scope="col">{DELIVERY_COPY.columnStatus}</th>
                  <th scope="col">{DELIVERY_COPY.columnEventId}</th>
                  <th scope="col">{DELIVERY_COPY.columnAttempts}</th>
                  <th scope="col">{DELIVERY_COPY.columnError}</th>
                  <th scope="col">{DELIVERY_COPY.columnUpdated}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      {/*
                        ⚠️ 送り直せるものにしかチェック欄を出さない。
                           出して API に断らせると「押したのに何も起きない」が並ぶ。
                      */}
                      {item.canResend ? (
                        <label className="sengoku-checkbox">
                          <input type="checkbox" name="deliveryId" value={item.id} />
                          <span className="sengoku-visually-hidden">
                            {DELIVERY_COPY.selectLabel}
                          </span>
                        </label>
                      ) : null}
                    </td>
                    <td>
                      <StatusBadge
                        label={deliveryStatusLabel(item.status)}
                        tone={deliveryStatusTone(item.status)}
                      />
                    </td>
                    <td className="sengoku-table__nowrap">
                      <a href={`/admin/wallet-deliveries/${encodeURIComponent(item.id)}`}>
                        {item.eventId}
                      </a>
                    </td>
                    <td className="sengoku-table__nowrap">
                      {String(item.attemptCount)} / {String(item.maxAttempts)}
                    </td>
                    <td className="sengoku-table__nowrap">
                      {deliveryErrorLabel(item.lastErrorCode)}
                    </td>
                    <td className="sengoku-table__nowrap">{formatDateTime(item.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {resendable.length === 0 ? (
            <p className="sengoku-form__hint">{DELIVERY_COPY.resendBlockedHint}</p>
          ) : null}
        </BulkResendForm>
      )}

      {nextCursor === null ? null : (
        <p>
          <a
            className="sengoku-button sengoku-button--quiet"
            href={nextPageHref(statuses, eventId, nextCursor)}
          >
            続きを表示する
          </a>
        </p>
      )}
    </>
  );
}

function toArray(value: string | string[] | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function toSingle(value: string | string[] | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Array.isArray(value) ? value[0] : value;
}

/** 続きのリンク。⚠️ 絞り込みを引き継ぐ。外すと 2 ページ目から条件が消える。 */
function nextPageHref(
  statuses: readonly string[],
  eventId: string | undefined,
  cursor: string,
): string {
  const params = new URLSearchParams();
  for (const status of statuses) {
    params.append('status', status);
  }
  if (eventId !== undefined && eventId !== '') {
    params.set('eventId', eventId);
  }
  params.set('cursor', cursor);
  return `/admin/wallet-deliveries?${params.toString()}`;
}
