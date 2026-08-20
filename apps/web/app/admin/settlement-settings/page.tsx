import { EmptyState, Notice, PageHeader } from '@sengoku/ui';
import { fetchSettlementSettings } from '../../../src/admin-client';
import { ADMIN_COPY } from '../../../src/admin-copy';
import { SETTLEMENT_COPY as COPY, transferFeeBearerLabel } from '../../../src/settlement-copy';
import { SettlementSettingsForm } from './form';

/**
 * 返金と精算の取り決め（`UD-104` / `UD-119`。決定 2026-08-20）。
 *
 * ⚠️ **ここで変えられるのは「これから」だけ。** 過去のご注文の返金期限は
 * そのご注文へ、確定した精算の内訳はその明細へ焼き付けてある
 * （`docs/SETTLEMENT_AND_REFUND.md` §1）。画面の頭でそう言い切っておく。
 * 書いておかないと、「日数を延ばせば先月の分も返せる」と思ったまま
 * 操作されてしまう。
 *
 * ⚠️ **返金そのものを行う口はここに置かない。** 返金の実行は注文の画面から
 * 行う。取り決めを変える場所と、個々のご注文を返金する場所を同じ画面に
 * すると、取り違えて押される。
 */
export default async function SettlementSettingsPage() {
  const result = await fetchSettlementSettings();

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

  const { settings } = result.data;

  return (
    <>
      <PageHeader title={COPY.title} description={COPY.description} />

      {/* ⚠️ いちばん先に出す。取り違えたときの影響がいちばん大きい。 */}
      <Notice tone="info" title={COPY.scopeTitle} hint={COPY.scopeHint} />

      {/*
        ⚠️ **未設定を既定値で埋めない。** 埋めると、誰も決めていない値が
           「決まっているもの」として運用に乗る。
      */}
      {settings === null ? (
        <Notice tone="alert" title={COPY.unsetTitle} hint={COPY.unsetHint} />
      ) : (
        <section>
          <h2>{COPY.currentHeading}</h2>
          <dl className="sengoku-facts">
            <dt>{COPY.fieldRefundWindow}</dt>
            <dd>{settings.refundWindowDays} 日</dd>
            <dt>{COPY.fieldPayoutOffset}</dt>
            <dd>{settings.payoutOffsetMonths} か月</dd>
            <dt>{COPY.fieldMinimumPayout}</dt>
            <dd>{settings.minimumPayoutAmount.toLocaleString('ja-JP')} 円</dd>
            <dt>{COPY.fieldTransferFeeBearer}</dt>
            <dd>{transferFeeBearerLabel(settings.transferFeeBearer)}</dd>
          </dl>
        </section>
      )}

      <section>
        <h2>{COPY.editHeading}</h2>
        <SettlementSettingsForm current={settings} />
      </section>
    </>
  );
}
