import { EmptyState, Notice, PageHeader, StatusBadge } from '@sengoku/ui';
import { fetchConsistency } from '../../../src/admin-client';
import { ADMIN_COPY } from '../../../src/admin-copy';
import {
  OPERATIONS_COPY,
  formatJst,
  severityLabel,
  severityTone,
} from '../../../src/operations-copy';

/**
 * 記録どうしの食い違いを数える画面（実運営 指示書 P0-6）。
 *
 * ⚠️ **ここでは直さない。** 「見つけたら直す」ボタンを置くと、
 * 何が起きていたのか分からないまま記録が書き換わる。食い違いは
 * 原因を確かめてから、それぞれの画面で直す。
 *
 * ⚠️ **0 件の項目も出す。** 「調べて 0 件だった」ことに値打ちがある。
 * 出さないと、調べていないのか 0 件なのかが区別できない。
 */
export default async function AdminConsistencyPage() {
  const result = await fetchConsistency();

  if (!result.ok) {
    return (
      <>
        <PageHeader title={OPERATIONS_COPY.consistencyTitle} />
        <EmptyState
          title={ADMIN_COPY.unavailableTitle(result.reason)}
          hint={ADMIN_COPY.unavailableHint}
        />
      </>
    );
  }

  const { overall, findings, generatedAt } = result.data;
  const found = findings.filter((row) => row.count > 0);

  return (
    <>
      <PageHeader
        title={OPERATIONS_COPY.consistencyTitle}
        description={OPERATIONS_COPY.consistencyDescription}
      />

      <Notice
        tone={overall === 'critical' ? 'alert' : 'info'}
        title={
          found.length === 0
            ? OPERATIONS_COPY.noFindings
            : `${String(found.length)} 種類の食い違いが見つかりました。`
        }
        hint={`${formatJst(generatedAt)} 時点`}
      />

      <div className="sengoku-table-scroll">
        <table className="sengoku-table sengoku-table--wide">
          <thead>
            <tr>
              <th scope="col">状態</th>
              <th scope="col">調べたこと</th>
              <th scope="col">件数</th>
              <th scope="col">次にすること</th>
            </tr>
          </thead>
          <tbody>
            {findings.map((row) => (
              <tr key={row.key}>
                <td>
                  <StatusBadge
                    label={severityLabel(row.severity)}
                    tone={severityTone(row.severity)}
                  />
                </td>
                <td>{row.label}</td>
                <td className="sengoku-table__nowrap">{String(row.count)} 件</td>
                <td>
                  {row.count === 0 ? '' : row.action}
                  {/*
                    ⚠️ **調べる口があるものは、そこへ繋ぐ。** 手がかりの
                       識別子だけ見せて「突き合わせてください」と言う画面は、
                       赤いまま放置される。
                  */}
                  {row.count > 0 && row.key === 'reserved_count_drift' ? (
                    <>
                      {' '}
                      <a href="/admin/consistency/reserved-count-drift">ずれた作品とご注文を見る</a>
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {found.length === 0 ? null : (
        <>
          <h2>手がかり</h2>
          {/*
            ⚠️ **全件は出さない。** 数千件あったときに画面が固まる。
               数は上の表に出ているので、ここは調べ始めるための手がかり。
          */}
          <p className="sengoku-form__hint">
            調べ始めるための識別子です。多いときは先頭のぶんだけをお見せします。
          </p>
          {found.map((row) => (
            <section key={row.key}>
              <h3>{row.label}</h3>
              {row.sampleIds.length === 0 ? (
                <p className="sengoku-form__hint">手がかりはありません。</p>
              ) : (
                <ul>
                  {row.sampleIds.map((id) => (
                    <li className="sengoku-code-inline" key={id}>
                      {id}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </>
      )}
    </>
  );
}
