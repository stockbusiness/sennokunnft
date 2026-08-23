import { EmptyState, Notice, PageHeader, StatusBadge } from '@sengoku/ui';
import { fetchReservedCountDrift } from '../../../../src/admin-client';
import { ADMIN_COPY } from '../../../../src/admin-copy';
import { RepairReservedCountForm } from '../forms';
import { OPERATIONS_COPY, formatJst } from '../../../../src/operations-copy';

/**
 * 押さえがずれた作品の一覧（`ADMIN_OPERATIONS_GAP.md` §I・2026-08-23）。
 *
 * ⚠️ **1 件ずつしか直せない。** 一括のボタンは置かない。ずれはバグ由来だと
 * 同時に何十件も出るので、一括だと**1 回の操作で、本人が下していない判断を
 * 数十件ぶん下せてしまう。**1 件ずつなら「50 回押している」こと自体が
 * 異常の合図になる（`ADMIN_OPERATIONS_GAP.md` §I・2026-08-24 決定）。
 *
 * ⚠️ **この画面が要る理由。** 食い違いの画面は作品の識別子しか出せず、
 * 「突き合わせて特定してください」としか言えなかった。**道具を渡さずに
 * 調べろと言う画面は、赤いまま放置される。**
 *
 * ⚠️ **お名前もメールも出さない。** API がそもそも返さない（`UD-503`）。
 * どなたのご注文かを辿るときは、注文番号から注文の画面へ回る。
 *
 * ⚠️ **スマホ操作前提。** 表は横スクロールに倒す。
 */
export default async function AdminReservedCountDriftPage() {
  const result = await fetchReservedCountDrift();

  if (!result.ok) {
    return (
      <>
        <PageHeader
          title={OPERATIONS_COPY.reservedCountDriftTitle}
          description={OPERATIONS_COPY.reservedCountDriftDescription}
        />
        <Notice
          tone="alert"
          title={ADMIN_COPY.unavailableTitle(result.reason)}
          hint={ADMIN_COPY.unavailableHint}
        />
      </>
    );
  }

  const { items, hasMore, generatedAt } = result.data;

  return (
    <>
      <PageHeader
        title={OPERATIONS_COPY.reservedCountDriftTitle}
        description={OPERATIONS_COPY.reservedCountDriftDescription}
      />

      <Notice
        tone={items.length === 0 ? 'info' : 'alert'}
        title={
          items.length === 0
            ? OPERATIONS_COPY.reservedCountDriftNone
            : `${String(items.length)} 件の作品でずれています。`
        }
        /*
          ⚠️ **切ったことを隠さない。** 全部見えていると読ませると、
             残りに気づかないまま「片付いた」と判断される。
        */
        hint={
          hasMore
            ? `${formatJst(generatedAt)} 時点。${OPERATIONS_COPY.reservedCountDriftTruncated}`
            : `${formatJst(generatedAt)} 時点`
        }
      />

      {items.length === 0 ? (
        <EmptyState
          title={OPERATIONS_COPY.reservedCountDriftNone}
          hint={OPERATIONS_COPY.reservedCountDriftNoneHint}
        />
      ) : (
        items.map((row) => (
          <section key={row.artworkId}>
            <h2>{row.artworkTitle}</h2>
            <p>
              <StatusBadge
                label={row.difference > 0 ? '押さえが多い' : '押さえが足りない'}
                tone={row.difference > 0 ? 'warning' : 'danger'}
              />
            </p>
            <dl className="sengoku-detail">
              <div>
                <dt>いま押さえている数</dt>
                <dd>{String(row.reservedCount)}</dd>
              </div>
              <div>
                <dt>あるべき数</dt>
                <dd>{String(row.expectedReservedCount)}</dd>
              </div>
              <div>
                <dt>差</dt>
                {/* ⚠️ 符号を出す。どちらへずれたかが読み取れなくなる。 */}
                <dd>
                  {row.difference > 0 ? `+${String(row.difference)}` : String(row.difference)}
                </dd>
              </div>
              <div>
                <dt>起きること</dt>
                <dd>{row.consequence}</dd>
              </div>
            </dl>

            {row.orders.length === 0 ? (
              <p className="sengoku-form__hint">
                この作品にお取り置きの記録がありません。押さえだけが立っています。
              </p>
            ) : (
              <div className="sengoku-table-scroll">
                <table className="sengoku-table sengoku-table--wide">
                  <caption className="sengoku-table__caption">
                    関わっているご注文（あるべき数の内訳）
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">注文番号</th>
                      <th scope="col">注文の状態</th>
                      <th scope="col">お取り置き</th>
                      <th scope="col">発行済み</th>
                      <th scope="col">まだ押さえている数</th>
                    </tr>
                  </thead>
                  <tbody>
                    {row.orders.map((order) => (
                      <tr key={order.orderId}>
                        <td>
                          <a href={`/admin/orders/${order.orderId}`}>{order.orderNumber}</a>
                        </td>
                        <td>{order.orderStatus}</td>
                        <td className="sengoku-table__nowrap">{String(order.heldQuantity)}</td>
                        <td className="sengoku-table__nowrap">{String(order.issuedCount)}</td>
                        <td className="sengoku-table__nowrap">{String(order.stillHeld)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/*
              ⚠️ **急ぐ向きと、そうでない向きを分けて書く。** 押さえが
                 足りない側はいま売り越しが起きうる。多い側は売れる枠が
                 売れないだけで、お客さまに二重に売ることはない。
              ⚠️ **多い側は「取り返しがつきにくい」。** 枠を解放するので、
                 数え直しが間違っていればすぐ売れてしまう。急かさない。
            */}
            <details className="sengoku-panel">
              <summary>この作品のお取り置きの数を直す</summary>
              <RepairReservedCountForm
                artworkId={row.artworkId}
                observedReservedCount={row.reservedCount}
                expectedReservedCount={row.expectedReservedCount}
              />
            </details>
          </section>
        ))
      )}

      <p className="sengoku-form__hint">{OPERATIONS_COPY.reservedCountRepairNote}</p>
    </>
  );
}
