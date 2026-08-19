import { describe, expect, it } from 'vitest';
import {
  ORDER_COPY,
  attemptStatusLabel,
  formatDateTime,
  formatFeeRate,
  fulfillmentStatusLabel,
  orderStatusLabel,
  orderStatusTone,
  payFailureHint,
  paymentStatusLabel,
  webhookStatusLabel,
} from './order-copy';

/**
 * 購入画面の言葉づかいを固定する。
 *
 * ⚠️ **これは見た目の趣味の話ではない。** 「ミント」「ウォレット」が
 * 1 語混ざるだけで、利用者は「自分には難しい」と手を止める。
 * 目で見て気づける保証ではないので、機械に見張らせる。
 */

/** 購入画面に出してはいけない語（指示書 §8）。 */
const FORBIDDEN = [
  'ミント',
  'mint',
  'Mint',
  'ウォレット',
  'wallet',
  'Wallet',
  'ブロックチェーン',
  'blockchain',
  'トークン',
  'NFT',
  '暗号資産',
  'ガス代',
];

describe('注文まわりの文言', () => {
  it('Web3 の言葉を含まない', () => {
    const all = Object.values(ORDER_COPY).join(' ');
    for (const word of FORBIDDEN) {
      expect(all).not.toContain(word);
    }
  });

  it('決済前の画面で「完了」と言い切らない', () => {
    /*
      ⚠️ 指示書 §12 の禁止表現。決済会社からの通知を受ける前に
         「購入完了」と書くと、払えていない人にも完了と伝わる。
    */
    expect(ORDER_COPY.payTitle).not.toContain('完了');
    expect(ORDER_COPY.confirmingTitle).not.toContain('完了');
    expect(ORDER_COPY.confirmingSlowTitle).not.toContain('失敗');
  });

  it('支払い済みでも「作品を受け取りました」と言わない', () => {
    // ⚠️ 受取権はまだ発行していない（Phase P3）。
    const paid = `${ORDER_COPY.paidTitle} ${ORDER_COPY.paidDescription}`;
    expect(paid).not.toContain('受け取りました');
    expect(paid).not.toContain('発行済み');
    // 「準備しています」と伝える。
    expect(paid).toContain('ご用意');
  });

  it('手数料が未設定のときに内部の設定値を見せない', () => {
    // ⚠️ 決定 C。買う人にできることが無い。
    const message = `${ORDER_COPY.setupIncompleteTitle} ${ORDER_COPY.setupIncompleteHint}`;
    expect(message).not.toContain('手数料');
    expect(message).not.toContain('PLATFORM_FEE');
    expect(message).toContain('準備');
  });

  it('決済の失敗で、拒否の理由を具体的に出さない', () => {
    // ⚠️ 指示書 §8。カードの事情を伝えても、利用者にできることは無い。
    const message = `${ORDER_COPY.payFailedTitle} ${ORDER_COPY.payFailedRetryHint}`;
    expect(message).not.toContain('カード');
    expect(message).not.toContain('残高');
    expect(message).not.toContain('declined');
    // 次の行動は示す。
    expect(message).toContain('もう一度');
  });

  it('失敗の案内は、期限内と期限切れで変わる', () => {
    expect(payFailureHint(false)).toBe(ORDER_COPY.payFailedRetryHint);
    expect(payFailureHint(true)).toBe(ORDER_COPY.payFailedExpiredHint);
    // 期限切れでは「もう一度お試し」と言わない。試しても通らない。
    expect(payFailureHint(true)).toContain('やり直して');
  });

  it('申し込みの段階で「完了」「購入しました」と言い切らない', () => {
    // ⚠️ お支払いはまだ済んでいない。済んだと読める言葉を置くと督促になる。
    expect(ORDER_COPY.pendingTitle).not.toContain('完了');
    expect(ORDER_COPY.pendingDescription).not.toContain('完了');
    expect(ORDER_COPY.pendingTitle).not.toContain('購入しました');
  });

  it('状態の札をすべて日本語で持つ', () => {
    expect(orderStatusLabel('checkout_created')).toBe('お支払い手続き中');
    expect(paymentStatusLabel('not_started')).toBe('未着手');
    expect(fulfillmentStatusLabel('fulfilled')).toBe('お渡し済み');
  });

  it('色は札と併せて使う（期限切れは警告側）', () => {
    expect(orderStatusTone('paid')).toBe('success');
    expect(orderStatusTone('expired')).toBe('warning');
    expect(orderStatusTone('pending')).toBe('neutral');
  });
});

describe('決済の状態の札', () => {
  it('試行の状態を日本語で持つ', () => {
    expect(attemptStatusLabel('pending')).toBe('お支払い待ち');
    expect(attemptStatusLabel('succeeded')).toBe('完了');
    expect(attemptStatusLabel('cancelled')).toBe('取り消し');
  });

  it('受信の処理状態を日本語で持つ', () => {
    expect(webhookStatusLabel('processed')).toBe('処理済み');
    expect(webhookStatusLabel('ignored')).toBe('対象外');
  });
});

describe('手数料率の表記', () => {
  it('0 は「未設定」と書く', () => {
    // ⚠️ 「0%」とだけ出すと、決まった結果に見える。決まっていない。
    expect(formatFeeRate(0)).toBe(ORDER_COPY.feeRateUndecided);
  });

  it('承認済みの 2000 は 20% と出す', () => {
    // ✅ 決定 C（2026-08-19）: プラットフォーム手数料 20%。
    expect(formatFeeRate(2000)).toBe('20%');
  });

  it('bps を割合に直す', () => {
    expect(formatFeeRate(1000)).toBe('10%');
    expect(formatFeeRate(1)).toBe('0.01%');
    expect(formatFeeRate(1250)).toBe('12.50%');
    expect(formatFeeRate(10_000)).toBe('100%');
  });
});

describe('日時の表記', () => {
  it('日本時間で出す', () => {
    // ⚠️ UTC のまま出すと、23時までの取り置きが 14時 と出て諦められる。
    const label = formatDateTime('2026-08-19T14:00:00.000Z');
    expect(label).toContain('23');
  });

  it('未設定は記号で埋める', () => {
    expect(formatDateTime(null)).toBe('—');
    expect(formatDateTime('not-a-date')).toBe('—');
  });
});
