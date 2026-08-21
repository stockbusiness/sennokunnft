import { EmptyState, Notice, PageHeader, StatusBadge } from '@sengoku/ui';
import { fetchOperationsDashboard } from '../../src/admin-client';
import { ADMIN_COPY } from '../../src/admin-copy';
import {
  OPERATIONS_COPY,
  formatJst,
  indicatorValue,
  overallMessage,
  severityLabel,
  severityTone,
} from '../../src/operations-copy';

/**
 * 運営が朝いちばんに開く画面（実運営 指示書 P0-6）。
 *
 * ⚠️ **赤は「いま手を動かす」ものだけ。** どれを赤にするかはドメインが
 * 決めている（`buildIndicators`）。画面側で色を足さない。足すと、
 * 判定が 2 か所に散って必ずずれる。
 *
 * ⚠️ **赤い行には必ず次の一手を出す。** 「異常です」だけを出しても、
 * 受け取った人は何をすればよいか分からない。分からないまま放置される
 * くらいなら、出さないほうがまだ害が少ない。
 *
 * ⚠️ **色だけで区別しない。** 印には言葉（要対応／確認／平常）を入れる。
 * 色の見分けがつかない方にも、順番が伝わるようにする。
 */
export default async function AdminDashboardPage() {
  const result = await fetchOperationsDashboard();

  if (!result.ok) {
    return (
      <>
        <PageHeader title={OPERATIONS_COPY.title} />
        <EmptyState
          title={ADMIN_COPY.unavailableTitle(result.reason)}
          hint={ADMIN_COPY.unavailableHint}
        />
      </>
    );
  }

  const { overall, indicators, lastWebhookReceivedAt, generatedAt } = result.data;
  /*
    ⚠️ **手当てが要るものを上に出す。** 全部を 1 つの表に並べると、
       赤い行が「本日のご注文」の下に埋もれる。運営は上から読む。
  */
  const actionable = indicators.filter((row) => row.severity !== 'normal');
  const routine = indicators.filter((row) => row.severity === 'normal');

  return (
    <>
      <PageHeader title={OPERATIONS_COPY.title} description={OPERATIONS_COPY.description} />

      <Notice
        tone={overall === 'critical' ? 'alert' : 'info'}
        title={overallMessage(overall)}
        hint={`${formatJst(generatedAt)} 時点`}
      />

      <h2>手当てが要ること</h2>
      {actionable.length === 0 ? (
        <EmptyState
          title={OPERATIONS_COPY.allClear}
          hint="下の一覧で、今日の動きをご確認いただけます。"
        />
      ) : (
        <div className="sengoku-table-scroll">
          <table className="sengoku-table sengoku-table--wide">
            <thead>
              <tr>
                <th scope="col">状態</th>
                <th scope="col">項目</th>
                <th scope="col">数</th>
                <th scope="col">次にすること</th>
              </tr>
            </thead>
            <tbody>
              {actionable.map((row) => (
                <tr key={row.key}>
                  <td>
                    <StatusBadge
                      label={severityLabel(row.severity)}
                      tone={severityTone(row.severity)}
                    />
                  </td>
                  <td>{row.label}</td>
                  <td className="sengoku-table__nowrap">{indicatorValue(row.key, row.count)}</td>
                  {/*
                    ⚠️ ドメインが必ず言葉を入れる。それでも `null` を書かない
                       ようにここで受ける。空欄のほうが「—」よりまだ読める。
                  */}
                  <td>{row.action ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>今日の動き</h2>
      <dl className="sengoku-definition-list">
        {routine.map((row) => (
          <div key={row.key}>
            <dt>{row.label}</dt>
            <dd>{indicatorValue(row.key, row.count)}</dd>
          </div>
        ))}
      </dl>

      <h2>決済の知らせ</h2>
      <p>
        最後に受け取ったのは {formatJst(lastWebhookReceivedAt)} です。
        {/*
          ⚠️ **静かなことを異常と断言しない。** ご注文が無ければ知らせも
             来ない。売れていない日と壊れている日を、ここからは区別できない。
        */}
      </p>
      <p className="sengoku-form__hint">
        ご注文が無ければ知らせは届きません。長く空いているときだけ、設定をご確認ください。
      </p>

      <h2>くわしく見る</h2>
      <ul>
        <li>
          <a href="/admin/entitlements">受取権の一覧（発行し直す・送り直す）</a>
        </li>
        <li>
          <a href="/admin/notifications">知らせの送信履歴</a>
        </li>
        <li>
          <a href="/admin/consistency">記録の食い違いを調べる</a>
        </li>
        <li>
          <a href="/admin/orders">注文を探す</a>
        </li>
      </ul>
    </>
  );
}
