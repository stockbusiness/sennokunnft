import { EmptyState, Notice, PageHeader, StatusBadge } from '@sengoku/ui';
import { fetchAttestations, fetchProductionReadiness } from '../../../src/admin-client';
import { ADMIN_COPY } from '../../../src/admin-copy';
import { formatJst } from '../../../src/operations-copy';
import {
  PRODUCTION_COPY,
  attestationKindLabel,
  attestationResultLabel,
  checkLabel,
  checkTone,
  enforcementNote,
  readinessMessage,
  unsatisfied,
} from '../../../src/production-copy';
import { AttestationForm, MailCheckForm } from './forms';

/**
 * 本番販売の準備（実運営 指示書 P0-7）。
 *
 * ⚠️ **画面を隠すことは保護ではない。** 条件が未達なら本番のお支払い口を
 * 作らせないのは API 側の仕事で、この画面は「いま何が足りないか」を
 * 見せるだけ。画面を出さなくても、支払い口を作る経路は直接叩ける。
 *
 * ⚠️ **「あと少し」と読ませない。** 9 つ満たしていても売れない。
 * 件数で安心させると、残る 1 つが些細に見える。
 */
export default async function AdminProductionPage() {
  const [readiness, attestations] = await Promise.all([
    fetchProductionReadiness(),
    fetchAttestations(),
  ]);

  if (!readiness.ok) {
    return (
      <>
        <PageHeader title={PRODUCTION_COPY.title} />
        <EmptyState
          title={ADMIN_COPY.unavailableTitle(readiness.reason)}
          hint={ADMIN_COPY.unavailableHint}
        />
      </>
    );
  }

  const { ready, enforced, environment, checks, credentialId, generatedAt } = readiness.data;
  const remaining = unsatisfied(checks);

  return (
    <>
      <PageHeader title={PRODUCTION_COPY.title} description={PRODUCTION_COPY.description} />

      <Notice
        tone={ready ? 'info' : 'alert'}
        title={readinessMessage(ready, enforced)}
        hint={ready ? PRODUCTION_COPY.readyHint : enforcementNote(enforced, environment)}
      />

      {/*
        ⚠️ **止まらない環境では、そのことをはっきり出す。** 「そろっている」
           ように見えて実は止めていない、が いちばん危ない。
      */}
      {enforced ? null : (
        <p className="sengoku-form__hint">{enforcementNote(enforced, environment)}</p>
      )}

      <h2>条件（{String(checks.length)} 件）</h2>
      {remaining.length === 0 ? null : (
        <p className="sengoku-form__hint">
          残っているのは {String(remaining.length)} 件です。**すべてそろうまで売れません。**
        </p>
      )}

      <div className="sengoku-table-scroll">
        <table className="sengoku-table sengoku-table--wide">
          <thead>
            <tr>
              <th scope="col">状態</th>
              <th scope="col">条件</th>
              <th scope="col">いまの状態</th>
              <th scope="col">次にすること</th>
            </tr>
          </thead>
          <tbody>
            {/* ⚠️ 満たしていないものを上に。運営は上から読む。 */}
            {[...checks]
              .sort((a, b) => Number(a.satisfied) - Number(b.satisfied))
              .map((row) => (
                <tr key={row.key}>
                  <td>
                    <StatusBadge
                      label={checkLabel(row.satisfied)}
                      tone={checkTone(row.satisfied)}
                    />
                  </td>
                  <td>{row.label}</td>
                  <td>{row.detail}</td>
                  {/* ⚠️ そろっていても直し方を出す。あとで崩れたときのため。 */}
                  <td>{row.satisfied ? '' : row.remedy}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <p className="sengoku-form__hint">{formatJst(generatedAt)} 時点</p>

      <h2>メールの試し送り</h2>
      <p className="sengoku-form__hint">
        ご自分の業務用アドレスへ 1 通お送りします。⚠️ 宛先は指定できません（この口が「誰にでも
        送れる口」にならないようにするためです）。
      </p>
      <MailCheckForm />

      <h2>{PRODUCTION_COPY.attestationsTitle}</h2>
      <Notice
        tone="alert"
        title="押した記録は消せません。"
        hint="訂正は、新しい記録を足して表します。決済の鍵を替えると、それまでの記録は失効します。"
      />

      {credentialId === null ? (
        <p className="sengoku-form__hint">
          受付中の決済の鍵がありません。先に決済の鍵を有効化してから記録してください。
        </p>
      ) : (
        <>
          <AttestationForm
            kind="e2e_sale_test"
            title="通し試験の結果を記録する"
            hint="本番の鍵で 1 件購入し、お届けまで通ることを確かめた結果を残します。"
          />
          <AttestationForm
            kind="owner_approval"
            title="本番販売の開始を承認する"
            hint="運営責任者として、本番販売を始めてよいと記録します。"
          />
        </>
      )}

      <h3>これまでの記録</h3>
      {!attestations.ok || attestations.data.items.length === 0 ? (
        <EmptyState title="まだ記録がありません。" />
      ) : (
        <div className="sengoku-table-scroll">
          <table className="sengoku-table sengoku-table--wide">
            <thead>
              <tr>
                <th scope="col">種別</th>
                <th scope="col">結果</th>
                <th scope="col">決済の鍵</th>
                <th scope="col">覚え書き</th>
                <th scope="col">日時</th>
              </tr>
            </thead>
            <tbody>
              {attestations.data.items.map((item) => (
                <tr key={item.id}>
                  <td>{attestationKindLabel(item.kind)}</td>
                  <td>
                    <StatusBadge
                      label={attestationResultLabel(item.succeeded)}
                      tone={item.succeeded ? 'success' : 'warning'}
                    />
                  </td>
                  <td className="sengoku-table__nowrap">
                    {/*
                      ⚠️ **いまの鍵と違うなら、その記録は失効している。**
                         見分けがつくようにする。
                    */}
                    {item.credentialId === credentialId ? '現行' : '失効（鍵が替わりました）'}
                  </td>
                  <td>{item.note ?? '—'}</td>
                  <td className="sengoku-table__nowrap">{formatJst(item.attestedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
