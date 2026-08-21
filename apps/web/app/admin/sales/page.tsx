import { EmptyState, Notice, PageHeader, PriceTag } from '@sengoku/ui';
import { fetchSalesReport } from '../../../src/admin-client';
import { ADMIN_COPY } from '../../../src/admin-copy';
import { formatDateTime } from '../../../src/order-copy';
import { SALES_REPORT_COPY as COPY, formatSignedYen } from '../../../src/reporting-copy';

/**
 * 運営の売上（`UD-123` の一部）。
 *
 * ⚠️ **ここに出るのは入金額ではない。** 決済事業者の手数料を引く前の値で
 * ある。画面の上でそう伝える——伝えないと、合わない額の原因を探す先を
 * 間違える。
 *
 * ⚠️ **数字を直す口を置かない。** 集計が出した値を読むだけ。訂正は元の
 * 記録（返金・精算）を直すことでしか起こらない。
 */
export default async function AdminSalesPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ granularity?: string }>;
}) {
  const params = await searchParams;
  const granularity = params.granularity === 'monthly' ? 'monthly' : 'daily';
  const result = await fetchSalesReport(granularity);

  if (!result.ok) {
    return (
      <>
        <PageHeader title={COPY.title} />
        <EmptyState
          title={ADMIN_COPY.unavailableTitle(result.reason)}
          hint={ADMIN_COPY.unavailableHint}
        />
      </>
    );
  }

  const { rows, totals, currency, from, to } = result.data;

  return (
    <>
      <PageHeader title={COPY.title} description={COPY.description} />

      {/* ⚠️ いちばん上に置く。下に置くと、数字を読んだあとに目に入る。 */}
      <Notice tone="alert" title={COPY.notInflowWarning} hint={COPY.notInflowHint} />

      <p className="sengoku-form__hint">{COPY.taxHint}</p>
      <p className="sengoku-form__hint">{COPY.refundDayHint}</p>

      <nav aria-label="集計の粒度">
        {/* ⚠️ いま見ている側も出す。押せる先だけだと、どちらか分からない。 */}
        <a href="/admin/sales?granularity=daily" aria-current={granularity === 'daily'}>
          {COPY.granularityDaily}
        </a>{' '}
        ／{' '}
        <a href="/admin/sales?granularity=monthly" aria-current={granularity === 'monthly'}>
          {COPY.granularityMonthly}
        </a>
      </nav>

      <p>
        {formatDateTime(from)} 〜 {formatDateTime(to)}
      </p>

      <section>
        <h2>{COPY.totalsHeading}</h2>
        <dl className="sengoku-facts">
          <dt>{COPY.columnOrders}</dt>
          <dd>{totals.orderCount.toLocaleString('ja-JP')} 件</dd>
          <dt>{COPY.columnGross}</dt>
          <dd>
            <PriceTag price={{ amount: totals.grossAmount, currency }} />
          </dd>
          <dt>{COPY.columnFee}</dt>
          <dd>
            <PriceTag price={{ amount: totals.platformFeeAmount, currency }} taxIncluded={false} />
          </dd>
          <dt>{COPY.columnCreator}</dt>
          <dd>
            <PriceTag price={{ amount: totals.creatorAmount, currency }} taxIncluded={false} />
          </dd>
          <dt>{COPY.columnRefunded}</dt>
          <dd>
            {formatSignedYen(totals.refundedAmount)}（{totals.refundCount.toLocaleString('ja-JP')}{' '}
            件）
          </dd>
          <dt>{COPY.columnNet}</dt>
          {/* ⚠️ マイナスを隠さない。返金が上回る期間はマイナスになる。 */}
          <dd>{formatSignedYen(totals.netAmount)}</dd>
        </dl>
      </section>

      <p>
        <a
          className="sengoku-button sengoku-button--quiet"
          href={`/admin/sales/csv?granularity=${granularity}`}
        >
          {COPY.csvLabel}
        </a>
      </p>

      <section>
        <h2>{granularity === 'monthly' ? COPY.granularityMonthly : COPY.granularityDaily}</h2>
        {rows.length === 0 ? (
          <EmptyState title={COPY.empty} />
        ) : (
          <div className="sengoku-table-scroll">
            <table className="sengoku-table">
              <thead>
                <tr>
                  <th scope="col">{COPY.columnPeriod}</th>
                  <th scope="col">{COPY.columnOrders}</th>
                  <th scope="col">{COPY.columnGross}</th>
                  <th scope="col">{COPY.columnFee}</th>
                  <th scope="col">{COPY.columnCreator}</th>
                  <th scope="col">{COPY.columnRefunded}</th>
                  <th scope="col">{COPY.columnNet}</th>
                </tr>
              </thead>
              <tbody>
                {/*
                  ⚠️ **売れなかった期間も行として出す。** 抜かすと、
                     「売れなかった」のか「集計できていない」のかが
                     見分けられない。
                */}
                {rows.map((row) => (
                  <tr key={row.periodKey}>
                    <th scope="row">{row.periodKey}</th>
                    <td>{row.orderCount.toLocaleString('ja-JP')}</td>
                    <td>{row.grossAmount.toLocaleString('ja-JP')} 円</td>
                    <td>{row.platformFeeAmount.toLocaleString('ja-JP')} 円</td>
                    <td>{row.creatorAmount.toLocaleString('ja-JP')} 円</td>
                    <td>{formatSignedYen(row.refundedAmount)}</td>
                    <td>{formatSignedYen(row.netAmount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
