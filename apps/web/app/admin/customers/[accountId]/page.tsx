import { EmptyState, Notice, PageHeader, StatusBadge } from '@sengoku/ui';
import { fetchCustomer } from '../../../../src/admin-client';
import { ADMIN_COPY } from '../../../../src/admin-copy';
import {
  CUSTOMER_COPY,
  accountStatusLabel,
  attentionTone,
  duplicateSignalLabel,
  emailChangeStatusLabel,
  emailChangeStatusTone,
  formatJst,
  formatYen,
  refundReasonLabel,
  shortId,
  verificationMethodLabel,
} from '../../../../src/customer-copy';
import {
  AddNoteForm,
  OpenEmailChangeForm,
  SettleEmailChangeForm,
  VerifyIdentityForm,
} from '../forms';

/**
 * お客さま 1 人の状況（実運営 指示書 P1-1）。
 *
 * ⚠️ **お名前もご連絡先も出ない。** 本システムはそもそも平文を持っていない
 * （`UD-503`）。API が返さないので、出しようが無い。
 *
 * ⚠️ **持ち主を付け替える操作はここに無い。** 注文・受取権・ウォレットの
 * 持ち主を人が変えられる口は、API にも画面にも存在しない。本人確認をして
 * いない付け替えは、他人の持ち物を渡すことと同じである。
 *
 * ⚠️ **救済は既存の画面へ回す。** Claim の再発行も、ウォレットへの再配送も、
 * それぞれの画面がすでにある。ここで作り直すと、規則が 2 か所に散る。
 */
export default async function AdminCustomerDetailPage({
  params,
}: {
  readonly params: Promise<{ readonly accountId: string }>;
}) {
  const { accountId } = await params;
  const result = await fetchCustomer(accountId);

  if (!result.ok) {
    return (
      <>
        <PageHeader title={CUSTOMER_COPY.title} />
        <EmptyState
          title={ADMIN_COPY.unavailableTitle(result.reason)}
          hint={ADMIN_COPY.unavailableHint}
        />
      </>
    );
  }

  const detail = result.data;
  const { summary } = detail;
  /*
    ⚠️ **決着していない申請は 1 件まで**（DB の部分 UNIQUE 索引）。
       それでも複数来たときに壊れないよう、先頭だけを操作の対象にする。
  */
  const openRequest = detail.emailChangeRequests.find(
    (row) => row.status === 'requested' || row.status === 'identity_verified',
  );

  return (
    <>
      <PageHeader
        title={`お客さま ${shortId(summary.accountId)}`}
        description="お問い合わせの応対にお使いください。"
      />

      <Notice
        tone="info"
        title="お名前とご連絡先は、この仕組みに保存されていません。"
        hint="ご本人の確認は、ご注文の内容や登録済みのご連絡先への確認で行ってください。"
      />

      <h2>{CUSTOMER_COPY.attentionHeading}</h2>
      {detail.attentions.length === 0 ? (
        <p>{CUSTOMER_COPY.allClear}</p>
      ) : (
        <ul className="sengoku-list">
          {detail.attentions.map((row) => (
            <li key={row.key}>
              <StatusBadge label={row.label} tone={attentionTone(row.key)} /> {row.detail}
            </li>
          ))}
        </ul>
      )}

      <h2>要約</h2>
      <dl className="sengoku-definition-list">
        <div>
          <dt>アカウントの状態</dt>
          <dd>
            <StatusBadge
              label={accountStatusLabel(summary.status)}
              tone={summary.status === 'suspended' ? 'danger' : 'neutral'}
            />
          </dd>
        </div>
        <div>
          <dt>共通顧客ID</dt>
          <dd className="sengoku-code-inline">{summary.commonUserId ?? '未解決'}</dd>
        </div>
        <div>
          <dt>ご注文</dt>
          <dd>{String(summary.orderCount)} 件</dd>
        </div>
        <div>
          <dt>お支払い</dt>
          <dd>{formatYen(summary.paidAmount)}</dd>
        </div>
        <div>
          <dt>ご返金</dt>
          <dd>{formatYen(summary.refundedAmount)}</dd>
        </div>
        <div>
          {/* ⚠️ 応対中に暗算させない。 */}
          <dt>差し引き</dt>
          <dd>
            <strong>{formatYen(summary.netPaidAmount)}</strong>
          </dd>
        </div>
        <div>
          <dt>はじめてのご注文</dt>
          <dd>{formatJst(summary.firstOrderAt)}</dd>
        </div>
        <div>
          <dt>直近のご注文</dt>
          <dd>{formatJst(summary.lastOrderAt)}</dd>
        </div>
        <div>
          <dt>代理店・紹介元</dt>
          {/* ⚠️ 埋まっているふりをしない。 */}
          <dd>{CUSTOMER_COPY.referralUnavailable}</dd>
        </div>
      </dl>

      <h2>{CUSTOMER_COPY.ordersHeading}</h2>
      {detail.orders.length === 0 ? (
        <p>ご注文はありません。</p>
      ) : (
        <div className="sengoku-table-scroll">
          <table className="sengoku-table sengoku-table--wide">
            <thead>
              <tr>
                <th scope="col">ご注文番号</th>
                <th scope="col">状態</th>
                <th scope="col">お支払い</th>
                <th scope="col">ご返金</th>
                <th scope="col">金額</th>
                <th scope="col">お申し込み</th>
              </tr>
            </thead>
            <tbody>
              {detail.orders.map((order) => (
                <tr key={order.id}>
                  <td className="sengoku-table__nowrap">
                    <a href={`/admin/orders/${encodeURIComponent(order.id)}`}>
                      {order.orderNumber}
                    </a>
                  </td>
                  <td className="sengoku-table__nowrap">{order.status}</td>
                  <td className="sengoku-table__nowrap">{order.paymentStatus}</td>
                  <td className="sengoku-table__nowrap">{order.refundStatus}</td>
                  <td className="sengoku-table__nowrap">{formatYen(order.totalAmount)}</td>
                  <td className="sengoku-table__nowrap">{formatJst(order.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>{CUSTOMER_COPY.entitlementsHeading}</h2>
      {detail.entitlements.length === 0 ? (
        <p>お渡ししたものはありません。</p>
      ) : (
        <div className="sengoku-table-scroll">
          <table className="sengoku-table sengoku-table--wide">
            <thead>
              <tr>
                <th scope="col">作品</th>
                <th scope="col">番号</th>
                <th scope="col">お受け取り</th>
                <th scope="col">お届け</th>
                <th scope="col">ご注文</th>
              </tr>
            </thead>
            <tbody>
              {detail.entitlements.map((row) => (
                <tr key={row.id}>
                  <td>{row.artworkTitle}</td>
                  <td className="sengoku-table__nowrap">第 {String(row.serialNo)} 番</td>
                  <td className="sengoku-table__nowrap">{formatJst(row.claimedAt)}</td>
                  <td className="sengoku-table__nowrap">{formatJst(row.walletDeliveredAt)}</td>
                  <td className="sengoku-table__nowrap">
                    <a href={`/admin/entitlements?orderId=${encodeURIComponent(row.id)}`}>
                      {row.orderNumber}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/*
        ⚠️ **救済はそれぞれの画面へ回す。** ここに同じボタンを作ると、
           規則が 2 か所に散る。
      */}
      <h2>手当て</h2>
      <ul>
        <li>
          <a href={`/admin/entitlements?accountId=${encodeURIComponent(accountId)}`}>
            受取権の一覧（発行し直す・その方ぶんを送り直す）
          </a>
        </li>
        <li>
          <a href="/admin/wallet-deliveries">お届けの一覧（理由を確かめて送り直す）</a>
        </li>
      </ul>

      <h2>{CUSTOMER_COPY.refundsHeading}</h2>
      {detail.refunds.length === 0 ? (
        <p>ご返金はありません。</p>
      ) : (
        <div className="sengoku-table-scroll">
          <table className="sengoku-table sengoku-table--wide">
            <thead>
              <tr>
                <th scope="col">ご注文番号</th>
                <th scope="col">金額</th>
                <th scope="col">理由</th>
                <th scope="col">状態</th>
                <th scope="col">受付</th>
              </tr>
            </thead>
            <tbody>
              {detail.refunds.map((row) => (
                <tr key={row.id}>
                  <td className="sengoku-table__nowrap">{row.orderNumber}</td>
                  <td className="sengoku-table__nowrap">{formatYen(row.amount)}</td>
                  <td>{refundReasonLabel(row.reason)}</td>
                  <td className="sengoku-table__nowrap">{row.status}</td>
                  <td className="sengoku-table__nowrap">{formatJst(row.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>{CUSTOMER_COPY.duplicatesHeading}</h2>
      {/* ⚠️ **統合できると読ませない。** */}
      <Notice tone="info" title={CUSTOMER_COPY.duplicatesHint} />
      {detail.duplicateCandidates.length === 0 ? (
        <p>手がかりの一致するアカウントはありません。</p>
      ) : (
        <div className="sengoku-table-scroll">
          <table className="sengoku-table sengoku-table--wide">
            <thead>
              <tr>
                <th scope="col">アカウント</th>
                <th scope="col">一致した手がかり</th>
                <th scope="col">状態</th>
                <th scope="col">ご注文</th>
                <th scope="col">お渡し</th>
              </tr>
            </thead>
            <tbody>
              {detail.duplicateCandidates.map((row) => (
                <tr key={row.accountId}>
                  <td className="sengoku-table__nowrap">
                    <a href={`/admin/customers/${encodeURIComponent(row.accountId)}`}>
                      {shortId(row.accountId)}
                    </a>
                  </td>
                  <td>{row.signals.map(duplicateSignalLabel).join('・')}</td>
                  <td className="sengoku-table__nowrap">{accountStatusLabel(row.status)}</td>
                  <td className="sengoku-table__nowrap">{String(row.orderCount)} 件</td>
                  <td className="sengoku-table__nowrap">{String(row.entitlementCount)} 点</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>{CUSTOMER_COPY.emailChangeHeading}</h2>
      <Notice tone="alert" title={CUSTOMER_COPY.emailChangeHint} />

      {detail.emailChangeRequests.length === 0 ? (
        <p>お申し出はありません。</p>
      ) : (
        <div className="sengoku-table-scroll">
          <table className="sengoku-table sengoku-table--wide">
            <thead>
              <tr>
                <th scope="col">状態</th>
                <th scope="col">新しいご連絡先</th>
                <th scope="col">本人確認</th>
                <th scope="col">確認した人</th>
                <th scope="col">受付</th>
              </tr>
            </thead>
            <tbody>
              {detail.emailChangeRequests.map((row) => (
                <tr key={row.id}>
                  <td>
                    <StatusBadge
                      label={emailChangeStatusLabel(row.status)}
                      tone={emailChangeStatusTone(row.status)}
                    />
                  </td>
                  {/* ⚠️ 伏せた表記そのもの。元へは戻せない。 */}
                  <td className="sengoku-code-inline">{row.requestedMaskedEmail}</td>
                  <td>{verificationMethodLabel(row.verificationMethod)}</td>
                  <td className="sengoku-table__nowrap">
                    {row.verifiedByAccountId === null ? '—' : shortId(row.verifiedByAccountId)}
                  </td>
                  <td className="sengoku-table__nowrap">{formatJst(row.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {openRequest === undefined ? (
        <OpenEmailChangeForm accountId={accountId} />
      ) : (
        <>
          <h3>お手続き中のお申し出</h3>
          <VerifyIdentityForm accountId={accountId} requestId={openRequest.id} />
          <SettleEmailChangeForm
            accountId={accountId}
            requestId={openRequest.id}
            canComplete={openRequest.status === 'identity_verified'}
          />
        </>
      )}

      <h2>{CUSTOMER_COPY.notesHeading}</h2>
      {detail.notes.length === 0 ? (
        <p>申し送りはありません。</p>
      ) : (
        <ul className="sengoku-list">
          {detail.notes.map((note) => (
            <li key={note.id}>
              <p>{note.body}</p>
              <p className="sengoku-form__hint">
                {shortId(note.authorAccountId)} / {formatJst(note.createdAt)}
              </p>
            </li>
          ))}
        </ul>
      )}
      <AddNoteForm accountId={accountId} />

      <p>
        <a className="sengoku-button sengoku-button--quiet" href="/admin/customers">
          お探しする画面へ戻る
        </a>
      </p>
    </>
  );
}
