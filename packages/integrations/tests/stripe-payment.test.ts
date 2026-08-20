import { describe, expect, it } from 'vitest';
import type Stripe from 'stripe';
import { toStripePaymentFact } from '../src/index';

/**
 * Stripe のイベントを業務の事象へ畳む部分の検査（指示書 §16.1）。
 *
 * ⚠️ **実ネットワークを使わない。** イベントの形は Stripe が決めるので、
 * ここで確かめられるのは「その形を受け取ったときにどう畳むか」まで。
 * 実際に Stripe がその形を送るかは、テストモードの通し試験の役目。
 */
function event(
  type: string,
  object: unknown,
  overrides: Record<string, unknown> = {},
): Stripe.Event {
  return {
    id: 'evt_test_1',
    object: 'event',
    api_version: '2026-07-29.dahlia',
    created: 1_787_000_000,
    livemode: false,
    pending_webhooks: 0,
    request: null,
    type,
    data: { object },
    ...overrides,
  } as unknown as Stripe.Event;
}

describe('Stripe イベントの正規化', () => {
  it('支払い済みの Checkout 完了を「成功」へ畳む', () => {
    const fact = toStripePaymentFact(
      event('checkout.session.completed', {
        id: 'cs_test_1',
        payment_status: 'paid',
        payment_intent: 'pi_test_1',
        amount_total: 12000,
        currency: 'jpy',
        metadata: { order_id: 'order-1' },
      }),
    );

    expect(fact.kind).toBe('succeeded');
    expect(fact.orderId).toBe('order-1');
    expect(fact.sessionRef).toBe('cs_test_1');
    expect(fact.paymentRef).toBe('pi_test_1');
    expect(fact.amount).toBe(12000);
    expect(fact.currency).toBe('jpy');
  });

  it('未払いの Checkout 完了は「成功」にしない', () => {
    /*
      ⚠️ **ここが今回いちばん間違えやすい。**
      銀行振込などの後払いでは、Checkout が終わっても入金はまだ。
      `completed` を見ただけで paid にすると、入金前に商品を渡す。
    */
    const fact = toStripePaymentFact(
      event('checkout.session.completed', {
        id: 'cs_test_2',
        payment_status: 'unpaid',
        payment_intent: 'pi_test_2',
        amount_total: 12000,
        currency: 'jpy',
        metadata: { order_id: 'order-1' },
      }),
    );

    expect(fact.kind).toBe('ignored');
  });

  it('Payment Intent の成功では受領額を使う', () => {
    // ⚠️ `amount` ではなく `amount_received`。請求しようとした額と
    //    実際に受け取った額は食い違うことがある。
    const fact = toStripePaymentFact(
      event('payment_intent.succeeded', {
        id: 'pi_test_3',
        amount: 12000,
        amount_received: 12000,
        currency: 'jpy',
        latest_charge: 'ch_test_3',
        metadata: { order_id: 'order-2' },
      }),
    );

    expect(fact.kind).toBe('succeeded');
    expect(fact.amount).toBe(12000);
    expect(fact.chargeRef).toBe('ch_test_3');
  });

  it('Checkout の期限切れを畳む', () => {
    const fact = toStripePaymentFact(
      event('checkout.session.expired', {
        id: 'cs_test_4',
        payment_status: 'unpaid',
        payment_intent: null,
        amount_total: 12000,
        currency: 'jpy',
        metadata: { order_id: 'order-3' },
      }),
    );

    expect(fact.kind).toBe('checkout_expired');
    expect(fact.orderId).toBe('order-3');
  });

  it('決済失敗の理由を許可リストへ通す', () => {
    const fact = toStripePaymentFact(
      event('payment_intent.payment_failed', {
        id: 'pi_test_5',
        metadata: { order_id: 'order-4' },
        last_payment_error: { code: 'card_declined' },
      }),
    );

    expect(fact.kind).toBe('failed');
    expect(fact.failureCode).toBe('card_declined');
  });

  it('知らない失敗理由は unknown へ畳む', () => {
    // ⚠️ カードの事情（盗難届など）をそのまま保存しない。
    const fact = toStripePaymentFact(
      event('payment_intent.payment_failed', {
        id: 'pi_test_6',
        metadata: { order_id: 'order-5' },
        last_payment_error: { code: 'stolen_card' },
      }),
    );

    expect(fact.failureCode).toBe('unknown');
  });

  it('知らないイベントは ignored にする（拒否しない）', () => {
    // ⚠️ 拒否すると Stripe が再送し続け、いずれ宛先ごと無効化される。
    const fact = toStripePaymentFact(event('charge.updated', { id: 'ch_test_7' }));
    expect(fact.kind).toBe('ignored');
    expect(fact.eventId).toBe('evt_test_1');
  });

  it('metadata に注文IDが無ければ null にする', () => {
    // 呼び出し側が「注文を特定できない」として扱えるようにする。
    const fact = toStripePaymentFact(
      event('payment_intent.succeeded', {
        id: 'pi_test_8',
        amount_received: 12000,
        currency: 'jpy',
        metadata: {},
      }),
    );
    expect(fact.orderId).toBeNull();
  });

  it('返金の知らせを「返金」へ畳み、累計を持ち出す', () => {
    /*
      ⚠️ **累計を取る。** 事業者は「この決済でいくら返したか」を積算で
         持つ。差分だと、知らせが前後して届いたときに合わなくなる。
      ⚠️ **`amount` は元の決済額。** 返した額と取り違えると、全額かどうかの
         判定が狂う。
    */
    const fact = toStripePaymentFact(
      event('charge.refunded', {
        id: 'ch_test_10',
        payment_intent: 'pi_test_10',
        amount: 12000,
        amount_refunded: 12000,
        currency: 'jpy',
        metadata: { order_id: 'order-10' },
        refunds: { data: [{ id: 're_test_10' }] },
      }),
    );

    expect(fact.kind).toBe('refunded');
    expect(fact.orderId).toBe('order-10');
    expect(fact.chargeRef).toBe('ch_test_10');
    expect(fact.paymentRef).toBe('pi_test_10');
    expect(fact.amount).toBe(12000);
    expect(fact.refundedTotal).toBe(12000);
    expect(fact.refundRef).toBe('re_test_10');
  });

  it('一部返金でも累計をそのまま持ち出す', () => {
    const fact = toStripePaymentFact(
      event('charge.refunded', {
        id: 'ch_test_11',
        payment_intent: 'pi_test_11',
        amount: 12000,
        amount_refunded: 3000,
        currency: 'jpy',
        metadata: { order_id: 'order-11' },
        refunds: { data: [{ id: 're_test_11' }] },
      }),
    );
    expect(fact.refundedTotal).toBe(3000);
  });

  it('返金の一覧が無くても畳める（識別子は null）', () => {
    // ⚠️ 無いものを推測で埋めない。二重反映の判定は識別子の有無で分かれる。
    const fact = toStripePaymentFact(
      event('charge.refunded', {
        id: 'ch_test_12',
        amount: 12000,
        amount_refunded: 12000,
        currency: 'jpy',
        metadata: { order_id: 'order-12' },
      }),
    );
    expect(fact.kind).toBe('refunded');
    expect(fact.refundRef).toBeNull();
  });

  it('返金でないイベントでは、返金の値が入らない', () => {
    const fact = toStripePaymentFact(
      event('payment_intent.succeeded', {
        id: 'pi_test_13',
        amount_received: 12000,
        currency: 'jpy',
        metadata: { order_id: 'order-13' },
      }),
    );
    expect(fact.refundRef).toBeNull();
    expect(fact.refundedTotal).toBeNull();
  });

  it('livemode と API バージョンを持ち出す', () => {
    // ⚠️ 本番と試験の取り違えを、呼び出し側が見分けられるようにする。
    const fact = toStripePaymentFact(
      event('charge.updated', { id: 'ch_test_9' }, { livemode: true }),
    );
    expect(fact.livemode).toBe(true);
    expect(fact.apiVersion).toBe('2026-07-29.dahlia');
  });
});
