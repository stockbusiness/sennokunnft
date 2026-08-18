import { EmptyState, Notice, PageHeader } from '@sengoku/ui';
import { fetchAuditLogs } from '../../../src/admin-client';
import { ADMIN_COPY, shortAccountId } from '../../../src/admin-copy';
import { AUDIT_COPY, auditActionLabel, formatDateTime } from '../../../src/delivery-copy';

/**
 * 操作の記録（管理画面・外部連携 指示書 §5）。
 *
 * ⚠️ **書き換える経路を作らない。** 人が直せる証跡は証跡ではない。
 * この画面は読むだけで、API 側にも書き込みの経路が無い。
 *
 * ⚠️ **伏せていることを画面に書く。** 何も言わずに伏せると、見た人は
 * 「記録されていない」と読む。記録はあるが見せていない、という違いは
 * 監査では重い。
 */
export default async function AdminAuditLogsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const action = toSingle(params.action);
  const cursor = toSingle(params.cursor);

  const result = await fetchAuditLogs({ action, cursor });

  if (!result.ok) {
    return (
      <>
        <PageHeader title={AUDIT_COPY.title} />
        <EmptyState
          title={ADMIN_COPY.unavailableTitle(result.reason)}
          hint={ADMIN_COPY.unavailableHint}
        />
      </>
    );
  }

  const { items, nextCursor, contactRedacted } = result.data;

  return (
    <>
      <PageHeader title={AUDIT_COPY.title} description={AUDIT_COPY.description} />

      {contactRedacted ? (
        <Notice tone="info" title={AUDIT_COPY.redactedNote} hint={AUDIT_COPY.redactedNoteHint} />
      ) : null}

      <form className="sengoku-form" method="get">
        <div className="sengoku-form__field">
          <label className="sengoku-form__label" htmlFor="audit-action">
            {AUDIT_COPY.filterAction}
          </label>
          <p className="sengoku-form__hint">{AUDIT_COPY.filterActionHint}</p>
          <input
            className="sengoku-form__input"
            id="audit-action"
            name="action"
            type="text"
            autoComplete="off"
            defaultValue={action ?? ''}
          />
        </div>
        <div className="sengoku-actions">
          <button className="sengoku-button" type="submit">
            {AUDIT_COPY.submitFilter}
          </button>
          <a className="sengoku-button sengoku-button--quiet" href="/admin/audit-logs">
            {AUDIT_COPY.submitClear}
          </a>
        </div>
      </form>

      {items.length === 0 ? (
        <EmptyState title={AUDIT_COPY.noItems} hint={AUDIT_COPY.noItemsHint} />
      ) : (
        <div className="sengoku-table-scroll">
          <table className="sengoku-table sengoku-table--wide">
            <thead>
              <tr>
                <th scope="col">{AUDIT_COPY.columnOccurredAt}</th>
                <th scope="col">{AUDIT_COPY.columnActor}</th>
                <th scope="col">{AUDIT_COPY.columnAction}</th>
                <th scope="col">{AUDIT_COPY.columnTarget}</th>
                <th scope="col">{AUDIT_COPY.columnSummary}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td className="sengoku-table__nowrap">{formatDateTime(item.occurredAt)}</td>
                  <td className="sengoku-table__nowrap">
                    {item.actorAccountId === null
                      ? AUDIT_COPY.actorSystem
                      : (item.actorEmail ?? shortAccountId(item.actorAccountId))}
                  </td>
                  <td className="sengoku-table__nowrap">{auditActionLabel(item.action)}</td>
                  <td className="sengoku-table__nowrap">{item.targetType}</td>
                  <td>
                    {/*
                      ⚠️ 要約は伏せ字処理を通ったものだけが届く（API 側）。
                         ここで生の記録を読み直さない。
                    */}
                    <SummaryList summary={item.summary} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {nextCursor === null ? null : (
        <p>
          <a
            className="sengoku-button sengoku-button--quiet"
            href={nextPageHref(action, nextCursor)}
          >
            続きを表示する
          </a>
        </p>
      )}
    </>
  );
}

/**
 * 要約を読める形で並べる。
 *
 * ⚠️ **JSON のまま出さない。** 運営が読むものなので、鍵と値を素直に並べる。
 * 値が入れ子のときだけ JSON へ落とす（そこまで読む場面は稀）。
 */
function SummaryList({ summary }: { readonly summary: Record<string, unknown> }) {
  const entries = Object.entries(summary);
  if (entries.length === 0) {
    return <span className="sengoku-form__hint">—</span>;
  }
  return (
    <ul className="sengoku-summary-list">
      {entries.map(([key, value]) => (
        <li key={key}>
          {key}: {stringify(value)}
        </li>
      ))}
    </ul>
  );
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) {
    return '—';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

function toSingle(value: string | string[] | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Array.isArray(value) ? value[0] : value;
}

/** 続きのリンク。⚠️ 絞り込みを引き継ぐ。 */
function nextPageHref(action: string | undefined, cursor: string): string {
  const params = new URLSearchParams();
  if (action !== undefined && action !== '') {
    params.set('action', action);
  }
  params.set('cursor', cursor);
  return `/admin/audit-logs?${params.toString()}`;
}
