import { EmptyState, Notice, PageHeader, PriceTag, StatusBadge } from '@sengoku/ui';
import { fetchDisputes } from '../../../src/admin-client';
import { ADMIN_COPY } from '../../../src/admin-copy';
import {
  OPERATIONS_COPY,
  disputeReasonLabel,
  disputeStatusLabel,
  disputeUrgencyLabel,
  disputeUrgencyTone,
  formatJst,
} from '../../../src/operations-copy';

/**
 * カード会社との争いの一覧（2026-08-22）。
 *
 * ⚠️ **読むだけの画面。** 証拠の提出も取り下げも決済事業者の画面で行う。
 * ここに操作を置くと、事業者の記録とこちらの記録が食い違う——正はあちら。
 *
 * ⚠️ **お名前もメールも出さない。** API がそもそも返さない（`UD-503`）。
 * どなたのご注文かを辿るときは、注文番号から注文の画面へ回る。
 *
 * ⚠️ **期限の早い順に出す。** 起きた順にすると、期限が明日のものが下へ沈む。
 * ⚠️ **スマホ操作前提。** 表は横スクロールに倒す。
 */
const STATE_CHOICES = [
  { value: 'open', label: '決着していないもの' },
  { value: 'closed', label: '決着したもの' },
  { value: 'all', label: 'すべて' },
] as const;

export default async function AdminDisputesPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params.state;
  const single = Array.isArray(raw) ? raw[0] : raw;
  // ⚠️ 知らない値は既定へ倒す。API 側の zod でも弾かれるが、画面でも揃える。
  const state = STATE_CHOICES.some((choice) => choice.value === single)
    ? (single as string)
    : 'open';

  const result = await fetchDisputes({ state });

  if (!result.ok) {
    return (
      <>
        <PageHeader title={OPERATIONS_COPY.disputesTitle} />
        <EmptyState
          title={ADMIN_COPY.unavailableTitle(result.reason)}
          hint={ADMIN_COPY.unavailableHint}
        />
      </>
    );
  }

  const { items, hasMore, dueSoonDays } = result.data;
  const urgent = items.filter(
    (item) => item.urgency === 'overdue' || item.urgency === 'due_soon',
  ).length;

  return (
    <>
      <PageHeader
        title={OPERATIONS_COPY.disputesTitle}
        description={OPERATIONS_COPY.disputesDescription}
      />

      {/*
        ⚠️ **期限の話を最初に出す。** 過ぎると自動的に負ける——こちらの
           言い分に関わらず、証拠を出さなかったという理由で敗訴になる。
           一覧の下に書いても読まれない。
      */}
      {urgent > 0 ? (
        <Notice
          tone="alert"
          title={`提出期限が迫っている、または過ぎているものが ${String(urgent)} 件あります。`}
          hint="期限を過ぎると、こちらの言い分に関わらず自動的に負けになります。決済事業者の画面で証拠をご提出ください。"
        />
      ) : (
        <Notice
          tone="info"
          title="お名前・メールアドレスはここには出ません。"
          hint={`どなたのご注文かを確かめるときは、注文番号から注文の画面へお進みください。提出期限の ${String(dueSoonDays)} 日前から赤でお知らせします。`}
        />
      )}

      <form className="sengoku-form" method="get">
        <div className="sengoku-form__field">
          <label className="sengoku-form__label" htmlFor="dispute-state">
            表示する範囲
          </label>
          <select
            className="sengoku-form__input"
            id="dispute-state"
            name="state"
            defaultValue={state}
          >
            {STATE_CHOICES.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </div>
        <div className="sengoku-actions">
          <button className="sengoku-button" type="submit">
            この条件で表示する
          </button>
        </div>
      </form>

      {items.length === 0 ? (
        <EmptyState
          title="あてはまる争いはありませんでした。"
          hint="決着したものを見るときは、表示する範囲をお切り替えください。"
        />
      ) : (
        <div className="sengoku-table-scroll">
          <table className="sengoku-table sengoku-table--wide">
            <thead>
              <tr>
                <th scope="col">急ぎ具合</th>
                <th scope="col">提出期限</th>
                <th scope="col">状態</th>
                <th scope="col">言われている理由</th>
                <th scope="col">ご注文</th>
                <th scope="col">作品</th>
                <th scope="col">争われている額</th>
                <th scope="col">申し立て</th>
                <th scope="col">事業者の識別子</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <StatusBadge
                      tone={disputeUrgencyTone(item.urgency)}
                      label={disputeUrgencyLabel(item.urgency)}
                    />
                  </td>
                  {/*
                    ⚠️ **期限が無いことを空欄にしない。** 空欄だと「まだ
                       読み込んでいない」のか「無い」のかが分からない。
                  */}
                  <td className="sengoku-table__nowrap">
                    {item.evidenceDueAt === null ? '—' : formatJst(item.evidenceDueAt)}
                  </td>
                  <td>
                    <StatusBadge label={disputeStatusLabel(item.status)} />
                  </td>
                  {/* ⚠️ 文字として描く。HTML として解釈しない。 */}
                  <td>{disputeReasonLabel(item.reason)}</td>
                  <td className="sengoku-table__nowrap">
                    <a href={`/admin/orders/${encodeURIComponent(item.orderId)}`}>
                      {item.orderNumber}
                    </a>
                  </td>
                  <td>{item.artworkTitleSnapshot}</td>
                  {/*
                    ⚠️ **争われている額を出す。** ご注文の総額と一致するとは
                       限らない（一部だけ争われることがある）。
                  */}
                  <td className="sengoku-table__nowrap">
                    <PriceTag
                      price={{ amount: item.amount, currency: item.currency }}
                      taxIncluded={false}
                    />
                  </td>
                  <td className="sengoku-table__nowrap">{formatJst(item.openedAt)}</td>
                  <td className="sengoku-code-inline">{item.disputeRef}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/*
        ⚠️ **切ったことを隠さない。** 全部見えていると読ませない。
      */}
      {hasMore ? (
        <Notice
          tone="alert"
          title="件数が多いため、一部のみ表示しています。"
          hint="表示する範囲を絞ってご確認ください。"
        />
      ) : null}
    </>
  );
}
