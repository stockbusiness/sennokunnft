import { notFound } from 'next/navigation';
import { EmptyState, Notice, PageHeader, PriceTag, StatusBadge } from '@sengoku/ui';
import { fetchPayout } from '../../../../src/admin-client';
import { ADMIN_COPY } from '../../../../src/admin-copy';
import { formatDateTime, formatFeeRate, shortId } from '../../../../src/order-copy';
import {
  PAYOUT_COPY as COPY,
  payoutStatusLabel,
  payoutStatusTone,
  transferFeeBearerLabelForPayout,
} from '../../../../src/payout-copy';
import { ConfirmPayoutForm, MarkPaidForm } from '../forms';

/**
 * 精算の明細（`UD-119`）。
 *
 * ⚠️ **金額を直す口を置かない**（`SETTLEMENT_AND_REFUND.md` §4）。
 * 訂正は翌月の精算での調整として行う。
 */
export default async function AdminPayoutDetailPage({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const result = await fetchPayout(id);

  if (!result.ok) {
    if (result.reason === 'not_found') {
      notFound();
    }
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

  const { payout, lines, openRefundWindows } = result.data;
  const currency = payout.currency;

  return (
    <>
      <PageHeader title={`${payout.periodKey} の精算`} description={COPY.title} />

      <p>
        <StatusBadge
          tone={payoutStatusTone(payout.status)}
          label={payoutStatusLabel(payout.status)}
        />{' '}
        <span className="sengoku-code-inline">{shortId(payout.creatorAccountId)}</span>
      </p>

      <dl className="sengoku-facts">
        <dt>{COPY.fieldPeriod}</dt>
        <dd>
          {formatDateTime(payout.periodStart)} 〜 {formatDateTime(payout.periodEnd)}
        </dd>
        <dt>{COPY.fieldDueAt}</dt>
        <dd>{formatDateTime(payout.dueAt)}</dd>
        <dt>{COPY.fieldGross}</dt>
        <dd>
          <PriceTag price={{ amount: payout.grossAmount, currency }} />
        </dd>
        <dt>{COPY.fieldFee}</dt>
        <dd>
          <PriceTag price={{ amount: payout.feeAmount, currency }} taxIncluded={false} />
        </dd>
        <dt>{COPY.fieldRefunded}</dt>
        <dd>
          <PriceTag price={{ amount: payout.refundedAmount, currency }} taxIncluded={false} />
        </dd>
        <dt>{COPY.fieldCarriedIn}</dt>
        <dd>{formatSigned(payout.carriedInAmount)}</dd>
        <dt>{COPY.fieldNet}</dt>
        <dd>
          <PriceTag price={{ amount: payout.netAmount, currency }} taxIncluded={false} />
        </dd>
        <dt>{COPY.fieldCarriedOut}</dt>
        <dd>{formatSigned(payout.carriedOutAmount)}</dd>
        {/*
          ⚠️ **「当時の」と書く。** いまの設定ではない。あとから設定を変えても
             この精算は動かない、ということを画面から読み取れるようにする。
        */}
        <dt>{COPY.fieldMinimum}</dt>
        <dd>{payout.minimumPayoutAmount.toLocaleString('ja-JP')} 円</dd>
        <dt>{COPY.fieldBearer}</dt>
        <dd>{transferFeeBearerLabelForPayout(payout.transferFeeBearer)}</dd>
        {payout.confirmedAt === null ? null : (
          <>
            <dt>確定</dt>
            <dd>{formatDateTime(payout.confirmedAt)}</dd>
          </>
        )}
        {payout.paidAt === null ? null : (
          <>
            <dt>お支払い済みの記録</dt>
            <dd>
              {formatDateTime(payout.paidAt)}
              {payout.paidByAccountId === null ? '' : ` ／ ${shortId(payout.paidByAccountId)}`}
            </dd>
          </>
        )}
      </dl>

      <section>
        <h2>{COPY.linesHeading}</h2>
        {lines.length === 0 ? (
          <p>この月に対象のご注文はありません（繰越のみ）。</p>
        ) : (
          <ul className="sengoku-order-list">
            {lines.map((line) => (
              <li className="sengoku-order-card" key={line.id}>
                <div className="sengoku-order-card__head">
                  <strong>{line.orderNumber}</strong>{' '}
                  {line.isClawback ? (
                    <StatusBadge tone="warning" label={COPY.clawbackLabel} />
                  ) : null}
                </div>
                {/* ⚠️ 文字として描く。HTML として解釈しない。 */}
                <p>{line.artworkTitleSnapshot}</p>
                <dl className="sengoku-facts">
                  <dt>{COPY.fieldGross}</dt>
                  <dd>
                    <PriceTag price={{ amount: line.grossAmount, currency }} />
                  </dd>
                  <dt>手数料</dt>
                  <dd>
                    {formatFeeRate(line.feeRateBps)} ／{' '}
                    <PriceTag price={{ amount: line.feeAmount, currency }} taxIncluded={false} />
                  </dd>
                  <dt>{COPY.fieldNet}</dt>
                  <dd>{formatSigned(line.netAmount)}</dd>
                </dl>
                {line.isClawback ? <p className="sengoku-form__hint">{COPY.clawbackHint}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/*
        ⚠️ **状態ごとに、いま押せる操作だけを出す。** 押せるのに効かない
           ボタンを並べると、押してから断られる。
      */}
      {payout.status === 'draft' ? (
        <section>
          <h2>確定</h2>
          <ConfirmPayoutForm payoutId={payout.id} openRefundWindows={openRefundWindows} />
        </section>
      ) : null}

      {payout.status === 'confirmed' ? (
        <section>
          <h2>お支払い</h2>
          <MarkPaidForm payoutId={payout.id} />
        </section>
      ) : null}

      {payout.status === 'paid' ? (
        <Notice
          tone="info"
          title={COPY.statusPaid}
          hint="訂正が要る場合は、翌月の精算での調整として行います。この精算は変更できません。"
        />
      ) : null}

      <p className="sengoku-back-link">
        <a href="/admin/payouts">精算の一覧へ戻る</a>
      </p>
    </>
  );
}

/**
 * 繰越と差し戻しの表示。
 *
 * ⚠️ **マイナスを隠さない。** 「−8,600 円」と出さないと、なぜ今月の
 * お支払いが少ないのかを運営が説明できない。
 */
function formatSigned(amount: number): string {
  const formatted = Math.abs(amount).toLocaleString('ja-JP');
  return amount < 0 ? `−${formatted} 円` : `${formatted} 円`;
}
