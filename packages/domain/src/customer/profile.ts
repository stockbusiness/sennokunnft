import type { EntitlementStatus } from '../state/machines';

/**
 * 顧客サポートのための集約（実運営 指示書 P1-1）。
 *
 * **問い合わせは「注文番号を控えていない人」から来る。** どの注文の話か、
 * 受け取れているのか、返金は済んでいるのか——それらが 1 画面に揃っていないと、
 * 応対する人が画面を 5 つ開いて突き合わせることになる。突き合わせは間違う。
 *
 * ⚠️ **氏名とメールアドレスの平文を、この形に入れない**（`UD-503`）。
 * 本システムはそもそも平文を持っていない。持っていないものを型に置くと、
 * 「どこかから取ってこよう」という改修を誘う。
 *
 * ⚠️ **付け替えの操作をここに置かない。** 注文・受取権・ウォレットの
 * 持ち主を人が変えられる口は作らない（指示書 §11）。本人確認をしていない
 * 付け替えは、他人の持ち物を渡すことと同じである。
 */

/** 買った方 1 人の要約。⚠️ 画面の見出しに出る値。 */
export interface CustomerSummary {
  readonly accountId: string;
  /** 伏せた表記（`t*****@e******.jp`）。⚠️ **ここから元へは戻せない。** */
  readonly maskedEmail: string | null;
  /**
   * 共通顧客ID（代理店システムが発行）。
   *
   * ⚠️ **未解決なら `null`。** 解決は別のジョブが進める。ここで
   * 「たぶんこの人」と推測しない。
   */
  readonly commonUserId: string | null;
  readonly status: 'active' | 'suspended';
  readonly orderCount: number;
  /** お支払いが成立した注文の合計（円）。⚠️ 返金は差し引かない（下に別で出す）。 */
  readonly paidAmount: number;
  /** 返金の合計（円）。 */
  readonly refundedAmount: number;
  readonly entitlementCount: number;
  /** まだお受け取りいただけていない数。⚠️ 問い合わせの大半がここ。 */
  readonly unclaimedCount: number;
  readonly firstOrderAt: Date | null;
  readonly lastOrderAt: Date | null;
}

/**
 * 実際にお渡ししたものの、いまの状態。
 *
 * ⚠️ **お受け取りの合言葉を含めない。** 画面に出すと、画面を見られた
 * だけで他人が受け取れてしまう。
 */
export interface CustomerEntitlement {
  readonly id: string;
  readonly orderNumber: string;
  readonly artworkTitle: string;
  readonly serialNo: number;
  readonly status: EntitlementStatus;
  readonly walletDeliveryStatus: string;
  readonly claimedAt: Date | null;
  readonly walletDeliveredAt: Date | null;
}

/**
 * 差し引き後の手取り。
 *
 * ⚠️ **画面で引き算をさせない。** 「支払い 36,000 円・返金 12,000 円」と
 * 並べると、応対中の人が暗算する。暗算は間違う。
 */
export function netPaidAmount(summary: CustomerSummary): number {
  // ⚠️ 負にしない。返金が支払いを超えるのは記録の食い違いで、ここで隠さない。
  return summary.paidAmount - summary.refundedAmount;
}

/**
 * 応対のときに真っ先に見るべきこと。
 *
 * ⚠️ **順序に意味がある。** 上から読めば、その方に何が起きているかが分かる。
 * 並べ替えるときは、応対する人の目線で考えること。
 */
export const CUSTOMER_ATTENTION_KEYS = [
  /** 停止中のアカウント。⚠️ まずこれ。ログインできない理由がここにある。 */
  'account_suspended',
  /** お受け取りがまだ。⚠️ 問い合わせの大半。 */
  'unclaimed_entitlements',
  /** ウォレットへのお届けが止まっている。 */
  'wallet_delivery_stalled',
  /** 共通顧客IDが未解決。⚠️ ウォレットへ届けられない。 */
  'common_user_unresolved',
  /** 返金の手続きが途中。 */
  'refund_in_progress',
] as const;
export type CustomerAttentionKey = (typeof CUSTOMER_ATTENTION_KEYS)[number];

export interface CustomerAttention {
  readonly key: CustomerAttentionKey;
  readonly label: string;
  readonly detail: string;
}

/**
 * その方について、応対の前に知っておくべきこと。
 *
 * ⚠️ **何も無ければ空で返す。** 「問題ありません」という行を作らない。
 * 作ると、応対する人はその行を読み飛ばす習慣がつき、問題があるときも読み飛ばす。
 */
export function customerAttentions(input: {
  readonly summary: CustomerSummary;
  readonly entitlements: readonly CustomerEntitlement[];
  readonly hasRefundInProgress: boolean;
}): readonly CustomerAttention[] {
  const { summary, entitlements } = input;
  const found: CustomerAttention[] = [];

  if (summary.status === 'suspended') {
    found.push({
      key: 'account_suspended',
      label: 'アカウントが停止中です',
      detail: 'ログインできない、購入できないというお問い合わせは、これが理由です。',
    });
  }

  if (summary.unclaimedCount > 0) {
    found.push({
      key: 'unclaimed_entitlements',
      label: 'お受け取りがお済みでない品があります',
      detail: `${String(summary.unclaimedCount)} 点。受取のご案内が届いていない可能性があります。`,
    });
  }

  /*
    ⚠️ **「受け取り済みなのに届いていない」だけを拾う。** 未受取のものは
       そもそも届ける先が無いので、ここに混ぜると常に出っぱなしになる。
  */
  const stalled = entitlements.filter(
    (row) => row.status === 'claimed' && row.walletDeliveryStatus !== 'delivered',
  );
  if (stalled.length > 0) {
    found.push({
      key: 'wallet_delivery_stalled',
      label: 'ウォレットへのお届けが済んでいません',
      detail: `${String(stalled.length)} 点。お届けをやり直せます。`,
    });
  }

  /*
    ⚠️ **受取権を持っているのに未解決のときだけ。** 何も買っていない方に
       出しても、応対する人にできることが無い。
  */
  if (summary.commonUserId === null && summary.entitlementCount > 0) {
    found.push({
      key: 'common_user_unresolved',
      label: '共通顧客IDが未解決です',
      detail: 'ウォレットへお届けできません。解決の巡回をお待ちください。',
    });
  }

  if (input.hasRefundInProgress) {
    found.push({
      key: 'refund_in_progress',
      label: 'ご返金の手続きが進行中です',
      detail: '事業者からの結果待ちです。',
    });
  }

  return found;
}
