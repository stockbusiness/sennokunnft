import { EmptyState, Notice, PageHeader, PriceTag, StatusBadge } from '@sengoku/ui';
import { fetchNegativeCarries, fetchPayouts } from '../../../src/admin-client';
import { ADMIN_COPY } from '../../../src/admin-copy';
import { formatDateTime, shortId } from '../../../src/order-copy';
import { PAYOUT_COPY as COPY, payoutStatusLabel, payoutStatusTone } from '../../../src/payout-copy';
import { ClosePeriodForm } from './forms';

/**
 * 作家さまへのお支払い（`UD-119`。決定 2026-08-20）。
 *
 * ⚠️ **金額を直す口を置かない**（`SETTLEMENT_AND_REFUND.md` §4）。訂正は
 * **翌月の精算での調整**として行う。画面にボタンだけ置くと、押しても
 * 動かない操作が残り、いつか「動くように直そう」と言われる。
 *
 * ⚠️ **精算を消す口も置かない。** 作り直しは下書きのときだけ、「締める」が
 * 置き換える形で行う。
 */
export default async function AdminPayoutsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const periodKey = one(params.periodKey);
  const [result, negativeCarries] = await Promise.all([
    fetchPayouts({ periodKey }),
    fetchNegativeCarries(),
  ]);

  return (
    <>
      <PageHeader title={COPY.title} description={COPY.description} />

      <section>
        <h2>{COPY.closeHeading}</h2>
        {/*
          ⚠️ **既定を「先月」にする。** いま締められるのは、いちばん近い
             締め済みの月。今月を出すと、必ず断られる欄を既定にすることになる。
        */}
        <ClosePeriodForm defaultPeriod={previousPeriodKey()} />
      </section>

      {/*
        お戻しが残っている作家さま（決定 2026-08-22）。

        ⚠️ **これが無いと、誰も気づかない。** 引ききれなかった分は翌月へ
           繰り越されるが、その作家さまが二度と売らなければ永久に残る。
           毎月の下書きには出るものの、他の下書きに埋もれて誰も拾わない。
        ⚠️ **取り立てる口は置かない。** 見えるようにするだけ。
      */}
      <section>
        <h2>{COPY.negativeHeading}</h2>
        <p className="sengoku-form__hint">{COPY.negativeHint}</p>
        {!negativeCarries.ok ? (
          <EmptyState
            title={ADMIN_COPY.unavailableTitle(negativeCarries.reason)}
            hint={ADMIN_COPY.unavailableHint}
          />
        ) : negativeCarries.data.items.length === 0 ? (
          <Notice tone="info" title={COPY.negativeEmpty} />
        ) : (
          <ul className="sengoku-order-list">
            {negativeCarries.data.items.map((row) => (
              <li className="sengoku-order-card" key={row.creatorAccountId}>
                <div className="sengoku-order-card__head">
                  {/* ⚠️ 氏名やメールは出せない（`UD-503`）。 */}
                  <strong>{shortId(row.creatorAccountId)}</strong>
                </div>
                <dl className="sengoku-detail-list">
                  <div>
                    <dt>{COPY.negativeAmount}</dt>
                    <dd>
                      <PriceTag price={{ amount: row.outstandingAmount, currency: 'JPY' }} />
                    </dd>
                  </div>
                  <div>
                    <dt>{COPY.negativePeriod}</dt>
                    <dd>{row.periodKey}</dd>
                  </div>
                  <div>
                    <dt>{COPY.negativeSince}</dt>
                    <dd>{formatDateTime(row.since)}</dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>{COPY.listHeading}</h2>
        {!result.ok ? (
          <EmptyState
            title={ADMIN_COPY.unavailableTitle(result.reason)}
            hint={ADMIN_COPY.unavailableHint}
          />
        ) : result.data.items.length === 0 ? (
          <Notice tone="info" title={COPY.listEmpty} hint={COPY.closeHint} />
        ) : (
          <ul className="sengoku-order-list">
            {result.data.items.map((row) => (
              <li className="sengoku-order-card" key={row.id}>
                <div className="sengoku-order-card__head">
                  <strong>{row.periodKey}</strong>{' '}
                  <StatusBadge
                    tone={payoutStatusTone(row.status)}
                    label={payoutStatusLabel(row.status)}
                  />{' '}
                  {/*
                    ⚠️ **氏名やメールは出せない**（`UD-503`）。見分けが付くのは
                       アカウントIDの先頭までで、それで足りる。
                  */}
                  <span className="sengoku-code-inline">{shortId(row.creatorAccountId)}</span>
                </div>

                <dl className="sengoku-facts">
                  <dt>{COPY.fieldNet}</dt>
                  <dd>
                    <PriceTag
                      price={{ amount: row.netAmount, currency: row.currency }}
                      taxIncluded={false}
                    />
                  </dd>
                  <dt>{COPY.fieldDueAt}</dt>
                  <dd>{formatDateTime(row.dueAt)}</dd>
                  <dt>{COPY.fieldLines}</dt>
                  <dd>{row.lineCount} 件</dd>
                </dl>

                <p>
                  <a href={`/admin/payouts/${row.id}`}>明細を見る</a>
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

/**
 * ひとつ前の締め月（JST）。
 *
 * ⚠️ **JST で数える。** UTC で数えると、月初の 9 時間だけ 2 か月前が出る。
 */
function previousPeriodKey(): string {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const year = jst.getUTCFullYear();
  const month = jst.getUTCMonth() + 1;
  const [y, m] = month === 1 ? [year - 1, 12] : [year, month - 1];
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`;
}

function one(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}
