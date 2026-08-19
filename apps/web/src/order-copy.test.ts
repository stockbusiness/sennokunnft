import { describe, expect, it } from 'vitest';
import {
  ORDER_COPY,
  formatDateTime,
  formatFeeRate,
  fulfillmentStatusLabel,
  orderStatusLabel,
  orderStatusTone,
  paymentStatusLabel,
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

describe('手数料率の表記', () => {
  it('0 は「未設定」と書く', () => {
    // ⚠️ 「0%」とだけ出すと、決まった結果に見える。決まっていない。
    expect(formatFeeRate(0)).toBe(ORDER_COPY.feeRateUndecided);
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
