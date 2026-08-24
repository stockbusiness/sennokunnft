import { EmptyState, Notice, PageHeader, StatusBadge } from '@sengoku/ui';
import { fetchReservedCountRepairs } from '../../../../src/admin-client';
import { ADMIN_COPY } from '../../../../src/admin-copy';
import { OPERATIONS_COPY, formatJst } from '../../../../src/operations-copy';
import { ResolveReservedCountRepairForm } from '../forms';

/**
 * 原因が分からないまま直した押さえの一覧（`ADMIN_OPERATIONS_GAP.md` §I）。
 *
 * ⚠️ **この画面が、修復の口を置けた理由そのものである。** 押さえを直すと
 * 食い違いの検知は 0 件へ戻る。そこで終わりにできると、**バグを黙って
 * 洗浄する機械**になる。直しても赤が消えないよう、原因未特定のものを
 * ここに残し続ける。
 *
 * > 2026-08-23 の実例: `reserved_count` がずれる原因が 1 件見つかった
 * > ——返金で押さえを二度戻していた。**直す口が先にあったら、押して
 * > 終わりにしていた可能性が高い。**
 *
 * ⚠️ **閉じるのは消すことではない。** 直したときの数と内訳は残る。
 *
 * ⚠️ **お名前もメールも出さない。** API がそもそも返さない（`UD-503`）。
 *
 * ⚠️ **スマホ操作前提。** 表は横スクロールに倒す。
 */
export default async function AdminReservedCountRepairsPage() {
  const result = await fetchReservedCountRepairs('pending');

  if (!result.ok) {
    return (
      <>
        <PageHeader
          title={OPERATIONS_COPY.reservedCountRepairTitle}
          description={OPERATIONS_COPY.reservedCountRepairDescription}
        />
        <Notice
          tone="alert"
          title={ADMIN_COPY.unavailableTitle(result.reason)}
          hint={ADMIN_COPY.unavailableHint}
        />
      </>
    );
  }

  const { items, hasMore, pendingCount, generatedAt } = result.data;

  return (
    <>
      <PageHeader
        title={OPERATIONS_COPY.reservedCountRepairTitle}
        description={OPERATIONS_COPY.reservedCountRepairDescription}
      />

      <Notice
        /*
          ⚠️ **赤（`alert`）にしない。** 押さえは数え直した値へ直っており、
             いま何かが壊れているわけではない。急ぐのは「直すこと」では
             なく「なぜそうなったかを突き止めること」。加えて `alert` は
             `role="alert"` になり、読み上げに割り込む——急ぎでないものを
             割り込ませると、本当に急ぐ知らせが軽くなる。
          ⚠️ **件数は見出しの言葉で伝える。** 色を落とすかわりに、
             「3 件、原因がまだ分かっていません」と数を出す。
        */
        tone="info"
        title={
          pendingCount === 0
            ? OPERATIONS_COPY.reservedCountRepairNone
            : `${String(pendingCount)} 件、原因がまだ分かっていません。`
        }
        hint={
          hasMore
            ? `${formatJst(generatedAt)} 時点。${OPERATIONS_COPY.reservedCountRepairTruncated}`
            : `${formatJst(generatedAt)} 時点`
        }
      />

      {items.length === 0 ? (
        <EmptyState
          title={OPERATIONS_COPY.reservedCountRepairNone}
          hint={OPERATIONS_COPY.reservedCountRepairNoneHint}
        />
      ) : (
        items.map((row) => (
          <section key={row.id}>
            <h2>{row.artworkTitle}</h2>
            <p>
              <StatusBadge
                label={row.direction === 'over' ? '押さえが多かった' : '押さえが足りなかった'}
                tone={row.direction === 'over' ? 'warning' : 'danger'}
              />
            </p>
            <dl className="sengoku-detail">
              <div>
                <dt>直す前</dt>
                <dd>{String(row.before)}</dd>
              </div>
              <div>
                <dt>直したあと</dt>
                <dd>{String(row.after)}</dd>
              </div>
              <div>
                <dt>差</dt>
                {/* ⚠️ 符号を出す。どちらへずれていたかが読み取れなくなる。 */}
                <dd>
                  {row.difference > 0 ? `+${String(row.difference)}` : String(row.difference)}
                </dd>
              </div>
              <div>
                <dt>直したとき</dt>
                <dd>{formatJst(row.repairedAt)}</dd>
              </div>
              <div>
                <dt>直した理由</dt>
                <dd>{row.reason}</dd>
              </div>
            </dl>

            {/*
              ⚠️ **内訳がこの記録の本体である。** 「5 → 2」だけでは後から
                 何ひとつ辿れない。どの注文が・いくつ押さえ・いくつ発行
                 済みだったかが残っているから、原因を追える。
            */}
            {row.snapshot.length === 0 ? (
              <p className="sengoku-form__hint">
                直したとき、この作品にお取り置きの記録はありませんでした。押さえだけが立っていた形です。
              </p>
            ) : (
              <div className="sengoku-table-scroll">
                <table className="sengoku-table sengoku-table--wide">
                  <caption className="sengoku-table__caption">
                    直す前の内訳（このご注文を辿ると原因が見つかります）
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">注文番号</th>
                      <th scope="col">注文の状態</th>
                      <th scope="col">お取り置き</th>
                      <th scope="col">発行済み</th>
                    </tr>
                  </thead>
                  <tbody>
                    {row.snapshot.map((order) => (
                      <tr key={order.orderId}>
                        <td>
                          <a href={`/admin/orders/${order.orderId}`}>{order.orderNumber}</a>
                        </td>
                        <td>{order.orderStatus}</td>
                        <td className="sengoku-table__nowrap">{String(order.heldQuantity)}</td>
                        <td className="sengoku-table__nowrap">{String(order.issuedCount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <details className="sengoku-panel">
              <summary>原因が分かったものとして閉じる</summary>
              <ResolveReservedCountRepairForm repairId={row.id} />
            </details>
          </section>
        ))
      )}

      <p className="sengoku-form__hint">{OPERATIONS_COPY.reservedCountRepairResolveNote}</p>
    </>
  );
}
