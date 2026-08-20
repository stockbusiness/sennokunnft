import { describe, expect, it } from 'vitest';
import { buildOrderTimeline, type OrderNoteEntry } from '../src/order/timeline';
import { ORDER_NOTE_MAX_LENGTH, validateOrderNote } from '../src/order/note';
import type {
  OrderView,
  PaymentAttemptView,
  WebhookReceiptRecord,
} from '../src/ports/order';

const AT = (iso: string): Date => new Date(iso);

function order(overrides: Partial<OrderView> = {}): OrderView {
  return {
    id: 'order-1',
    orderNumber: 'SNK-20260819-ABCDEFGH',
    accountId: 'account-1',
    creatorAccountId: 'creator-1',
    status: 'paid',
    paymentStatus: 'succeeded',
    fulfillmentStatus: 'not_started',
    refundStatus: 'none',
    currency: 'JPY',
    subtotalAmount: 12000,
    discountAmount: 0,
    totalAmount: 12000,
    platformFeeRateBps: 2000,
    platformFeeAmount: 2400,
    creatorAmount: 9600,
    reservationExpiresAt: null,
    paidAt: AT('2026-08-19T03:00:00.000Z'),
    idempotencyKeyPrefix: 'abcdefgh',
    createdAt: AT('2026-08-19T01:00:00.000Z'),
    item: {
      id: 'line-1',
      listingId: 'listing-1',
      artworkId: 'artwork-1',
      creatorAccountId: 'creator-1',
      titleSnapshot: '春の宵',
      unitPriceAmount: 12000,
      unitPriceCurrency: 'JPY',
      quantity: 1,
      totalAmount: 12000,
    },
    reservation: null,
    hasPayment: true,
    entitlementCount: 1,
    ...overrides,
  };
}

const attempt: PaymentAttemptView = {
  id: 'payment-1',
  provider: 'stripe',
  status: 'succeeded',
  sessionRef: 'cs_test_1',
  paymentRef: 'pi_1',
  chargeRef: 'ch_1',
  // ⚠️ 支払いページの URL。経過へ出してはいけない値の見本。
  url: 'https://checkout.example/pay/secret',
  amount: 12000,
  currency: 'JPY',
  expiresAt: AT('2026-08-19T02:00:00.000Z'),
  paidAt: AT('2026-08-19T02:30:00.000Z'),
  failureCode: null,
  createdAt: AT('2026-08-19T01:10:00.000Z'),
};

const receipt: WebhookReceiptRecord = {
  eventType: 'checkout.session.completed',
  status: 'processed',
  livemode: false,
  apiVersion: '2026-07-29.dahlia',
  attemptCount: 1,
  receivedAt: AT('2026-08-19T02:31:00.000Z'),
  processedAt: AT('2026-08-19T02:31:02.000Z'),
  lastErrorCode: null,
};

describe('buildOrderTimeline', () => {
  it('決済の試行・受信記録・対応メモを 1 列に、古い順で並べる', () => {
    const notes: readonly OrderNoteEntry[] = [
      {
        id: 'note-1',
        authorAccountId: 'operator-1',
        body: 'お電話にてご案内。',
        createdAt: AT('2026-08-19T04:00:00.000Z'),
      },
    ];

    const entries = buildOrderTimeline({
      order: order(),
      attempts: [attempt],
      webhooks: [receipt],
      notes,
    });

    expect(entries.map((entry) => entry.kind)).toEqual([
      'order_created',
      'checkout_created',
      'checkout_expires',
      'payment_succeeded',
      'webhook_received',
      'webhook_processed',
      'order_paid',
      'support_note',
    ]);

    // ⚠️ 古い順であること。逆順だと因果が逆に読める。
    const times = entries.map((entry) => entry.at.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('支払いページの URL を経過へ出さない（持つ人は誰でも支払える）', () => {
    const entries = buildOrderTimeline({
      order: order(),
      attempts: [attempt],
      webhooks: [],
      notes: [],
    });
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain('checkout.example');
    expect(serialized).not.toContain('secret');
  });

  it('時刻の無い出来事は並べない（それらしい時刻を作らない）', () => {
    // 期限切れの注文。「いつ切れたか」の記録は無い。
    const entries = buildOrderTimeline({
      order: order({ status: 'expired', paidAt: null, paymentStatus: 'cancelled' }),
      attempts: [],
      webhooks: [],
      notes: [],
    });
    expect(entries.map((entry) => entry.kind)).toEqual(['order_created']);
  });

  it('お取り置きの記録があれば、期限・確定・解放を並べる', () => {
    const entries = buildOrderTimeline({
      order: order({
        reservation: {
          id: 'reservation-1',
          status: 'consumed',
          quantity: 1,
          expiresAt: AT('2026-08-19T01:30:00.000Z'),
          consumedAt: AT('2026-08-19T02:31:00.000Z'),
          releasedAt: null,
        },
      }),
      attempts: [],
      webhooks: [],
      notes: [],
    });
    expect(entries.map((entry) => entry.kind)).toEqual([
      'order_created',
      'reservation_expires',
      'reservation_consumed',
      'order_paid',
    ]);
  });

  it('同時刻でも並び順が決まっている（見るたびに入れ替わらない）', () => {
    const same = AT('2026-08-19T01:00:00.000Z');
    const first = buildOrderTimeline({
      order: order({ createdAt: same, paidAt: same }),
      attempts: [{ ...attempt, createdAt: same, expiresAt: null, paidAt: null }],
      webhooks: [],
      notes: [],
    });
    const second = buildOrderTimeline({
      order: order({ createdAt: same, paidAt: same }),
      attempts: [{ ...attempt, createdAt: same, expiresAt: null, paidAt: null }],
      webhooks: [],
      notes: [],
    });
    expect(first.map((entry) => entry.kind)).toEqual(second.map((entry) => entry.kind));
  });
});

describe('validateOrderNote', () => {
  const draft = { orderId: 'order-1', authorAccountId: 'operator-1' };

  it('前後の空白を落として保存する', () => {
    const result = validateOrderNote({ ...draft, body: '  お電話にてご案内。  ' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.body).toBe('お電話にてご案内。');
  });

  it('空のメモは残さない（対応したのか読み取れなくなる）', () => {
    expect(validateOrderNote({ ...draft, body: '   ' }).ok).toBe(false);
  });

  it('上限を超える本文は受け付けない', () => {
    const result = validateOrderNote({ ...draft, body: 'あ'.repeat(ORDER_NOTE_MAX_LENGTH + 1) });
    expect(result.ok).toBe(false);
  });

  /**
   * ⚠️ **`UD-503` を守る要の 1 件。**
   * 購入者のメールアドレスを保持しないと決めたのに、対応メモへ
   * 書き写せてしまうと、決めた意味が無くなる。しかもメモは
   * 「ここに個人情報がある」とどこにも書かれていない表へ溜まる。
   */
  it('平文のメールアドレスを含む本文を拒む', () => {
    const result = validateOrderNote({
      ...draft,
      body: 'ご連絡先は buyer@example.com とのこと。',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('ORDER_NOTE_INVALID');
  });

  it('HTML は弾かない（運営の自由文に `<` は普通に出てくる）', () => {
    // ⚠️ 安全は「描き方」で担保する。画面は必ず文字として描く。
    const result = validateOrderNote({ ...draft, body: '価格 < 送料 の件で問い合わせ' });
    expect(result.ok).toBe(true);
  });

  it('改行は通す（メモは複数行で書かれる）', () => {
    const result = validateOrderNote({ ...draft, body: '1. 受付\n2. 折り返し' });
    expect(result.ok).toBe(true);
  });

  it('制御文字は弾く', () => {
    const result = validateOrderNote({ ...draft, body: `不正\u0007な文字` });
    expect(result.ok).toBe(false);
  });
});
