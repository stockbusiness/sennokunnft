import type { CollectibleView, OrderView } from '@sengoku/contracts';

/**
 * 買った方の画面の文言（P0-3）。
 *
 * ⚠️ **内部の言葉をそのまま出さない。** `issued` / `claimed` /
 * `delivery_pending` は運営の言葉で、買った方には「いま何が起きているか」が
 * 伝わらない。伝えるのは**状態の名前ではなく、いまどうなっているか**。
 *
 * ⚠️ **Web3 用語を出さない。** NFT →「デジタル作品」、Wallet →
 * 「受取用のウォレット」、Mint →「発行」。
 *
 * ⚠️ **「値上がり」「利益」「投資」を書かない。** 販売の性質を誤らせる。
 */

export const ACCOUNT_COPY = {
  homeTitle: 'マイページ',
  homeDescription: 'ご注文と、お受け取りいただいた作品を確認できます。',

  ordersTitle: 'ご注文の履歴',
  ordersDescription: 'これまでのお申し込みの一覧です。',
  noOrders: 'まだご注文はありません',
  noOrdersHint: '店先から作品をお選びいただけます。',

  collectiblesTitle: 'お受け取りの作品',
  collectiblesDescription: 'お買い上げいただいた作品の一覧です。',
  noCollectibles: 'まだお受け取りの作品はありません',
  noCollectiblesHint: 'お支払いが済むと、こちらに並びます。',

  settingsTitle: '設定',
  settingsDescription: 'ログインとお受け取りの設定です。',

  orderNumberLabel: 'ご注文番号',
  orderedAtLabel: 'お申し込み日時',
  amountLabel: 'お支払い金額',
  paymentLabel: 'お支払い',
  deliveryLabel: 'お受け取り',
  serialLabel: '番号',
  creatorLabel: '出品者',
  acquiredAtLabel: 'お受け取り日',

  detailLink: '内容を見る',
  backToAccount: '← マイページへ戻る',
  toOrders: 'ご注文の履歴',
  toCollectibles: 'お受け取りの作品',
  toSettings: '設定',

  /*
    ⚠️ **問い合わせ先はここに書かない。** 連絡先は法務文書（特商法表記）が
       正で、2 か所に書くと必ず食い違う。案内だけ置いて、そちらへ送る。
  */
  supportTitle: 'お困りのときは',
  supportHint: 'ご注文番号をお手元にご用意のうえ、下記の連絡先までお問い合わせください。',
  supportLink: '連絡先を見る（特定商取引法に基づく表記）',

  walletTitle: '受取用のウォレット',
  walletRegisteredHint: 'お支払いが済みしだい、こちらから自動でお届けします。',
  /*
    ⚠️ **登録していない方を責める言い方にしない。** 登録は任意で、
       していなくても受け取れる（受取用のURLからお渡しする）。
  */
  walletUnregisteredNotice: '受取用のウォレットをご登録いただくと、自動でお届けします',
  walletUnregisteredHint:
    'ご登録がなくても、お受け取りいただけます。作品の欄に受け取り方のご案内が出ます。',
} as const;

/**
 * お支払いの状態を、買った方の言葉にする。
 *
 * ⚠️ **「失敗」を突き放さない。** もう一度お試しいただけることを併せて伝える。
 */
export function paymentStateLabel(order: OrderView): string {
  if (order.paymentStatus === 'succeeded') {
    return 'お支払いが済んでいます';
  }
  if (order.paymentStatus === 'refunded') {
    return 'ご返金が済んでいます';
  }
  if (order.paymentStatus === 'failed') {
    return 'お支払いを完了できませんでした';
  }
  if (order.paymentStatus === 'cancelled') {
    return 'お申し込みを取り消しました';
  }
  if (order.paymentStatus === 'pending') {
    return 'お支払いを確認しています';
  }
  if (order.status === 'expired') {
    return 'お取り置きの期限が過ぎました';
  }
  return 'お支払いをお待ちしています';
}

/**
 * お受け取りの状態を、買った方の言葉にする（指示書 §6 の対応表）。
 *
 * | 内部状態           | 表示                     |
 * | ------------------ | ------------------------ |
 * | `PENDING`          | 発行の準備をしています   |
 * | `DELIVERY_PENDING` | ウォレットへお届け中です |
 * | `DELIVERED`        | お受け取りが完了しました |
 *
 * ⚠️ **`EXPIRED` / `REVOKED` に理由を書かない。** 事情は人によって違い、
 * 画面で言い当てると外れる。運営に相談していただく形にする。
 */
export function deliveryStateLabel(status: CollectibleView['status']): string {
  switch (status) {
    case 'PENDING':
      return '発行の準備をしています';
    case 'DELIVERY_PENDING':
      return 'ウォレットへお届け中です';
    case 'DELIVERED':
      return 'お受け取りが完了しました';
    case 'EXPIRED':
      return 'お受け取りの期限が過ぎています';
    case 'REVOKED':
      return '運営が確認しています';
  }
}

/** お受け取りが済んでいるか。⚠️ 色だけで区別せず、言葉でも伝える。 */
export function deliveryTone(
  status: CollectibleView['status'],
): 'success' | 'progress' | 'warning' {
  if (status === 'DELIVERED') return 'success';
  if (status === 'EXPIRED' || status === 'REVOKED') return 'warning';
  return 'progress';
}

/**
 * ご注文について、いま案内すべきことを 1 つだけ返す。
 *
 * ⚠️ **1 つに絞る**（指示書 §6）。次にすべきことを複数並べると、
 * どれから手を付ければよいのか分からなくなる。スマートフォンでは
 * とくに、画面の上に置けるのは 1 つだけ。
 */
export interface NextStep {
  readonly title: string;
  readonly hint: string;
  readonly href?: string;
  readonly linkLabel?: string;
}

export function nextStepFor(orders: readonly OrderView[]): NextStep | null {
  // ⚠️ 順序に意味がある。**お金が動く話を先に**出す。
  const unpaid = orders.find(
    (order) =>
      order.status !== 'expired' &&
      order.status !== 'cancelled' &&
      (order.paymentStatus === 'not_started' || order.paymentStatus === 'pending'),
  );
  if (unpaid !== undefined) {
    return {
      title: 'お支払いのお手続きが残っています',
      hint: `ご注文番号 ${unpaid.orderNumber} のお支払いが完了していません。`,
      href: `/account/orders/${unpaid.id}`,
      linkLabel: '内容を見る',
    };
  }

  const failed = orders.find((order) => order.paymentStatus === 'failed');
  if (failed !== undefined) {
    return {
      title: 'お支払いを完了できませんでした',
      hint: `ご注文番号 ${failed.orderNumber} は、もう一度お手続きいただけます。`,
      href: `/account/orders/${failed.id}`,
      linkLabel: '内容を見る',
    };
  }

  return null;
}
