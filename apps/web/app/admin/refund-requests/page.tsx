import Link from 'next/link';
import { EmptyState, Notice, PageHeader, StatusBadge } from '@sengoku/ui';
import { REFUND_REQUEST_STATUS_VALUES } from '@sengoku/contracts';
import { fetchRefundRequests } from '../../../src/admin-client';
import { ADMIN_COPY } from '../../../src/admin-copy';
import { formatDateTime, shortId } from '../../../src/order-copy';
import {
  REFUND_REQUEST_COPY as COPY,
  refundReasonLabel,
  refundRequestStatusLabel,
  refundRequestStatusTone,
} from '../../../src/refund-request-copy';
import { OpenRefundRequestForm } from './forms';

/**
 * 返金のお申し出（方針整理 2026-08-22）。
 *
 * ⚠️ **作家さまが見る画面ではない。** 作家さまには事実確認だけをお見せする
 * （`/creator/refund-inquiries`）。金額も、どなたが買われたかも出さない。
 *
 * ⚠️ **一覧に金額を出すが、そのまま承認へ渡さない。** 承認では金額を
 * 打ち直していただく。一覧の額は「いくらのお申し出か」を掴むためのもの。
 */
export default async function AdminRefundRequestsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const status = one(params.status);
  const result = await fetchRefundRequests({ status });

  return (
    <>
      <PageHeader title={COPY.adminTitle} description={COPY.adminDescription} />

      <section>
        <h2>{COPY.listHeading}</h2>

        {/*
          ⚠️ **絞り込みはリンクにする。** 押した状態が URL に残るので、
             「承認待ちの一覧」を運営どうしで共有できる。
        */}
        <nav className="sengoku-filter" aria-label={COPY.filterStatus}>
          <FilterLink current={status} value={undefined} label={COPY.filterAll} />
          {REFUND_REQUEST_STATUS_VALUES.map((value) => (
            <FilterLink
              key={value}
              current={status}
              value={value}
              label={refundRequestStatusLabel(value)}
            />
          ))}
        </nav>

        {!result.ok ? (
          <EmptyState
            title={ADMIN_COPY.unavailableTitle(result.reason)}
            hint={ADMIN_COPY.unavailableHint}
          />
        ) : result.data.items.length === 0 ? (
          <Notice tone="info" title={COPY.listEmpty} />
        ) : (
          <ul className="sengoku-order-list">
            {result.data.items.map((row) => (
              <li className="sengoku-order-card" key={row.id}>
                <div className="sengoku-order-card__head">
                  <StatusBadge
                    tone={refundRequestStatusTone(row.status)}
                    label={refundRequestStatusLabel(row.status)}
                  />{' '}
                  <strong>{refundReasonLabel(row.reason)}</strong>
                </div>
                <dl className="sengoku-detail-list">
                  <div>
                    <dt>{COPY.fieldAmount}</dt>
                    <dd>{row.amount.toLocaleString('ja-JP')} 円</dd>
                  </div>
                  <div>
                    <dt>{COPY.fieldOrder}</dt>
                    {/* ⚠️ 氏名やメールは出せない（`UD-503`）。注文で辿る。 */}
                    <dd>{shortId(row.orderId)}</dd>
                  </div>
                  <div>
                    <dt>{COPY.fieldCreatedAt}</dt>
                    <dd>{formatDateTime(row.createdAt)}</dd>
                  </div>
                </dl>
                <Link className="sengoku-link" href={`/admin/refund-requests/${row.id}`}>
                  {COPY.detailHeading}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>{COPY.openHeading}</h2>
        <OpenRefundRequestForm />
      </section>
    </>
  );
}

function FilterLink({
  current,
  value,
  label,
}: {
  readonly current: string | undefined;
  readonly value: string | undefined;
  readonly label: string;
}) {
  const active = current === value;
  const href =
    value === undefined ? '/admin/refund-requests' : `/admin/refund-requests?status=${value}`;
  return (
    <Link className="sengoku-link" href={href} aria-current={active ? 'page' : undefined}>
      {active ? `● ${label}` : label}
    </Link>
  );
}

function one(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value === '' ? undefined : value;
}
