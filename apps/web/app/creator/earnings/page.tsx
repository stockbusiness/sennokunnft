import { EmptyState, Notice, PageHeader, StatusBadge } from '@sengoku/ui';
import type { CreatorPeriodEarningsView } from '@sengoku/contracts';
import { fetchMyEarnings, fetchMyEarningsDetail } from '../../../src/creator-client';
import {
  CREATOR_COPY,
  creatorErrorMessage,
  earningsStateLabel,
  earningsStateTone,
  formatPeriodKey,
} from '../../../src/creator-copy';
import { formatJst, formatYen } from '../../../src/customer-copy';
import { formatFeeRate } from '../../../src/order-copy';

/**
 * 作家さまの売上（実運営 指示書 P1-2）。
 *
 * ⚠️ **「見込み」と「確定」を同じ顔で出さない。** 締めるまでは動く数字で
 * ある。同じ見た目にすると、あとで減ったときに「話が違う」になる。
 *
 * ⚠️ **誰の分かを問い合わせで渡さない。** アカウントは API がトークンから
 * 決める。渡せる形にすると、そこが他人の商いを覗く道になる。
 */
export default async function CreatorEarningsPage() {
  const [earnings, detail] = await Promise.all([fetchMyEarnings(), fetchMyEarningsDetail()]);

  if (!earnings.ok) {
    return (
      <>
        <PageHeader
          title={CREATOR_COPY.earningsTitle}
          description={CREATOR_COPY.earningsDescription}
        />
        <Notice tone="alert" title={creatorErrorMessage(earnings.reason, earnings.code)} />
        <p className="sengoku-creator-actions">
          <a href="/creator">{CREATOR_COPY.backToList}</a>
        </p>
      </>
    );
  }

  const { current, history, byArtwork, nextPayout } = earnings.data;

  return (
    <>
      <PageHeader
        title={CREATOR_COPY.earningsTitle}
        description={CREATOR_COPY.earningsDescription}
      />

      {/* --- 今月ぶん（見込み） --- */}
      <section className="sengoku-panel">
        <h2 className="sengoku-panel__title">
          {CREATOR_COPY.earningsCurrentTitle}{' '}
          <StatusBadge
            label={earningsStateLabel(current.state)}
            tone={earningsStateTone(current.state)}
          />
        </h2>
        <p className="sengoku-form__hint">{CREATOR_COPY.earningsCurrentHint}</p>
        <PeriodFigures period={current} />

        {/*
          ⚠️ **「なぜまだ確定しないのか」を書く。** 理由が無いと、
             待たされているのか止まっているのかが分からない。
        */}
        {current.openRefundWindows > 0 ? (
          <Notice
            title={CREATOR_COPY.earningsOpenRefundNotice}
            hint={CREATOR_COPY.earningsOpenRefundHint}
          />
        ) : null}

        {/*
          ⚠️ **「なぜ今月は少ないのか」を書く**（決定 B・2026-08-22）。
             合計だけ減って理由が無いと、ご不安をおかけする。
          ⚠️ **0 件なら出さない。** 常に出すと、何も起きていない月まで
             不穏に見える。
        */}
        {current.deferredDisputeCount > 0 ? (
          <Notice
            title={CREATOR_COPY.earningsDeferredDisputeNotice(
              current.deferredDisputeCount,
              current.deferredDisputeAmount,
            )}
            hint={CREATOR_COPY.earningsDeferredDisputeHint}
          />
        ) : null}
      </section>

      {/* --- 次回のお振込 --- */}
      <section className="sengoku-panel">
        <h2 className="sengoku-panel__title">{CREATOR_COPY.earningsNextTitle}</h2>
        {nextPayout === null ? (
          /*
            ⚠️ **0 円の振込予定を出さない。** 期待させておいて何も起きない。
               繰り越されることまで書く。
          */
          <EmptyState
            title={CREATOR_COPY.earningsNoNextPayout}
            hint={CREATOR_COPY.earningsNoNextPayoutHint}
          />
        ) : (
          <dl className="sengoku-figures">
            <div className="sengoku-figures__item">
              <dt>お振込の額</dt>
              <dd className="sengoku-figures__value">{formatYen(nextPayout.amount)}</dd>
            </div>
            <div className="sengoku-figures__item">
              <dt>お振込のご予定</dt>
              <dd className="sengoku-figures__value">{formatJst(nextPayout.dueAt)}</dd>
            </div>
            <div className="sengoku-figures__item">
              <dt>対象の月</dt>
              <dd className="sengoku-figures__value">{formatPeriodKey(nextPayout.periodKey)}</dd>
            </div>
          </dl>
        )}
      </section>

      {/* --- 作品ごとの売れ行き --- */}
      <section className="sengoku-panel">
        <h2 className="sengoku-panel__title">{CREATOR_COPY.earningsByArtworkTitle}</h2>
        {byArtwork.length === 0 ? (
          <EmptyState
            title={CREATOR_COPY.earningsNoSales}
            hint={CREATOR_COPY.earningsNoSalesHint}
          />
        ) : (
          <div className="sengoku-table-scroll">
            <table className="sengoku-table">
              <thead>
                <tr>
                  <th scope="col">作品名</th>
                  <th scope="col">売れた数</th>
                  <th scope="col">販売額</th>
                  <th scope="col">手数料</th>
                  <th scope="col">お支払額</th>
                  <th scope="col">ご返金</th>
                </tr>
              </thead>
              <tbody>
                {byArtwork.map((row) => (
                  <tr key={row.artworkTitleSnapshot}>
                    <td>{row.artworkTitleSnapshot}</td>
                    <td>{row.soldCount}</td>
                    <td>{formatYen(row.grossAmount)}</td>
                    <td>{formatYen(row.feeAmount)}</td>
                    <td>{formatYen(row.netAmount)}</td>
                    <td>{row.clawbackCount === 0 ? '—' : `${String(row.clawbackCount)} 件`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {/* ⚠️ 売れた数から黙って引かない。引いていないことを書く。 */}
        <p className="sengoku-form__hint">{CREATOR_COPY.earningsClawbackNote}</p>
      </section>

      {/* --- 明細 --- */}
      <section className="sengoku-panel">
        <h2 className="sengoku-panel__title">{CREATOR_COPY.earningsDetailTitle}</h2>
        <p className="sengoku-form__hint">{CREATOR_COPY.earningsCsvHint}</p>
        {/*
          ⚠️ **通常のリンクにする。** CSV は API が
             `content-disposition: attachment` を付けて返す。
        */}
        <p className="sengoku-creator-actions">
          <a className="sengoku-button sengoku-button--quiet" href="/creator/earnings/csv">
            {CREATOR_COPY.earningsCsvLink}
          </a>
        </p>

        {!detail.ok ? (
          <Notice tone="alert" title={creatorErrorMessage(detail.reason, detail.code)} />
        ) : detail.data.lines.length === 0 ? (
          <EmptyState
            title={CREATOR_COPY.earningsNoSales}
            hint={CREATOR_COPY.earningsNoSalesHint}
          />
        ) : (
          <div className="sengoku-table-scroll">
            <table className="sengoku-table">
              <thead>
                <tr>
                  <th scope="col">注文番号</th>
                  <th scope="col">作品名</th>
                  <th scope="col">販売額</th>
                  <th scope="col">手数料率</th>
                  <th scope="col">手数料</th>
                  <th scope="col">お支払額</th>
                  <th scope="col">区分</th>
                </tr>
              </thead>
              <tbody>
                {detail.data.lines.map((line) => (
                  <tr key={`${line.orderNumber}-${String(line.isClawback)}`}>
                    <td>{line.orderNumber}</td>
                    <td>{line.artworkTitleSnapshot}</td>
                    <td>{formatYen(line.grossAmount)}</td>
                    <td>{formatFeeRate(line.feeRateBps)}</td>
                    <td>{formatYen(line.feeAmount)}</td>
                    <td>{formatYen(line.netAmount)}</td>
                    <td>{line.isClawback ? 'ご返金' : 'お買い上げ'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* --- これまでのお支払い --- */}
      <section className="sengoku-panel">
        <h2 className="sengoku-panel__title">{CREATOR_COPY.earningsHistoryTitle}</h2>
        {history.length === 0 ? (
          <EmptyState
            title={CREATOR_COPY.earningsNoHistory}
            hint={CREATOR_COPY.earningsNoHistoryHint}
          />
        ) : (
          <div className="sengoku-table-scroll">
            <table className="sengoku-table">
              <thead>
                <tr>
                  <th scope="col">対象の月</th>
                  <th scope="col">状態</th>
                  <th scope="col">販売額</th>
                  <th scope="col">手数料</th>
                  <th scope="col">ご返金</th>
                  <th scope="col">お支払額</th>
                  <th scope="col">繰越</th>
                </tr>
              </thead>
              <tbody>
                {history.map((period) => (
                  <tr key={period.periodKey}>
                    <td>{formatPeriodKey(period.periodKey)}</td>
                    <td>
                      <StatusBadge
                        label={earningsStateLabel(period.state)}
                        tone={earningsStateTone(period.state)}
                      />
                    </td>
                    <td>{formatYen(period.grossAmount)}</td>
                    <td>{formatYen(period.feeAmount)}</td>
                    <td>{formatYen(period.refundedAmount)}</td>
                    <td>{formatYen(period.netAmount)}</td>
                    <td>{formatYen(period.carriedOutAmount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="sengoku-creator-actions">
        <a href="/creator">{CREATOR_COPY.backToList}</a>
      </p>
    </>
  );
}

/** 期間 1 つぶんの数字。⚠️ 繰越を必ず出す。「消えた」と読ませないため。 */
function PeriodFigures({ period }: { period: CreatorPeriodEarningsView }) {
  return (
    <dl className="sengoku-figures">
      <div className="sengoku-figures__item">
        <dt>販売額</dt>
        <dd className="sengoku-figures__value">{formatYen(period.grossAmount)}</dd>
      </div>
      <div className="sengoku-figures__item">
        <dt>手数料</dt>
        <dd className="sengoku-figures__value">{formatYen(period.feeAmount)}</dd>
      </div>
      <div className="sengoku-figures__item">
        <dt>ご返金</dt>
        <dd className="sengoku-figures__value">{formatYen(period.refundedAmount)}</dd>
      </div>
      <div className="sengoku-figures__item">
        <dt>前の月からの繰越</dt>
        <dd className="sengoku-figures__value">{formatYen(period.carriedInAmount)}</dd>
      </div>
      <div className="sengoku-figures__item">
        <dt>お支払いの対象</dt>
        <dd className="sengoku-figures__value">{formatYen(period.netAmount)}</dd>
      </div>
      <div className="sengoku-figures__item">
        <dt>次の月への繰越</dt>
        <dd className="sengoku-figures__value">{formatYen(period.carriedOutAmount)}</dd>
      </div>
      <div className="sengoku-figures__item">
        <dt>最低支払額</dt>
        <dd className="sengoku-figures__value">{formatYen(period.minimumPayoutAmount)}</dd>
      </div>
      <div className="sengoku-figures__item">
        <dt>お振込のご予定</dt>
        <dd className="sengoku-figures__value">{formatJst(period.dueAt)}</dd>
      </div>
    </dl>
  );
}
