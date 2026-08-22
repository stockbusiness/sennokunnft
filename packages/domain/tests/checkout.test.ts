import { describe, expect, it } from 'vitest';
import {
  decideCheckout,
  isSessionUsable,
  verifyPaymentFact,
  isLivemodeConsistent,
  toSafeFailureCode,
  type CheckoutEligibilityInput,
  type CheckoutSessionSnapshot,
  type OrderPaymentExpectation,
  type ProviderPaymentFact,
} from '../src/index';

const NOW = new Date('2026-08-19T00:00:00.000Z');
const RESERVED_UNTIL = new Date('2026-08-19T00:30:00.000Z');

/** 承認済みの手数料率（20%）。0 は「未設定」を意味する。 */
const APPROVED_FEE_RATE_BPS = 2000;

function input(overrides: Partial<CheckoutEligibilityInput> = {}): CheckoutEligibilityInput {
  return {
    orderStatus: 'pending',
    paymentStatus: 'not_started',
    platformFeeRateBps: APPROVED_FEE_RATE_BPS,
    reservationExpiresAt: RESERVED_UNTIL,
    existingSession: null,
    now: NOW,
    ...overrides,
  };
}

function session(overrides: Partial<CheckoutSessionSnapshot> = {}): CheckoutSessionSnapshot {
  return {
    paymentId: 'payment-1',
    sessionRef: 'cs_test_1',
    url: 'https://checkout.example.test/cs_test_1',
    status: 'pending',
    expiresAt: RESERVED_UNTIL,
    ...overrides,
  };
}

describe('決済を始めてよいかの判定', () => {
  it('条件がそろえば新しい支払い口を作る', () => {
    const decision = decideCheckout(input());
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.value.kind).toBe('create');
    }
  });

  it('手数料率が未設定（0）なら作らせない', () => {
    /*
      ⚠️ **0 は「手数料無料」ではなく「販売設定未完了」**（UD-109 の決定）。
         ここを通すと、率を決める前に 0% で売れてしまう。あとから率を
         変えても、注文時点の値を焼き付ける設計なので過去分は 0% のまま。
    */
    const decision = decideCheckout(input({ platformFeeRateBps: 0 }));
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.error.code).toBe('SALES_SETUP_INCOMPLETE');
    }
  });

  it('手数料率が負なら作らせない', () => {
    const decision = decideCheckout(input({ platformFeeRateBps: -1 }));
    expect(decision.ok).toBe(false);
  });

  it('支払い済みの注文には作らせない', () => {
    // ⚠️ 作ると二重に払える。返金でしか戻せない。
    for (const overrides of [
      { orderStatus: 'paid' } as const,
      { paymentStatus: 'succeeded' } as const,
    ]) {
      const decision = decideCheckout(input(overrides));
      expect(decision.ok).toBe(false);
      if (!decision.ok) {
        expect(decision.error.code).toBe('CHECKOUT_NOT_ALLOWED');
      }
    }
  });

  it('終わった注文には作らせない', () => {
    for (const status of ['expired', 'cancelled'] as const) {
      expect(decideCheckout(input({ orderStatus: status })).ok).toBe(false);
    }
  });

  it('お取り置きの期限が過ぎていたら作らせない', () => {
    const decision = decideCheckout(input({ now: new Date(RESERVED_UNTIL.getTime() + 1000) }));
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.error.code).toBe('RESERVATION_EXPIRED');
    }
  });

  it('期限ちょうどは「切れている」として扱う', () => {
    // 境界は閉じる側へ倒す。1 ミリ秒の差で在庫の取り合いにしない。
    const decision = decideCheckout(input({ now: RESERVED_UNTIL }));
    expect(decision.ok).toBe(false);
  });

  it('お取り置きが無い注文には作らせない', () => {
    expect(decideCheckout(input({ reservationExpiresAt: null })).ok).toBe(false);
  });

  it('決済が失敗していても、期限内なら作り直せる（決定B）', () => {
    // 注文は checkout_created のまま。pending へ戻さない。
    const decision = decideCheckout(
      input({
        orderStatus: 'checkout_created',
        paymentStatus: 'failed',
        existingSession: session({ status: 'failed' }),
      }),
    );
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.value.kind).toBe('create');
    }
  });

  it('決済が失敗していても、期限が切れていれば作れない（決定B）', () => {
    const decision = decideCheckout(
      input({
        orderStatus: 'checkout_created',
        paymentStatus: 'failed',
        existingSession: session({ status: 'failed' }),
        now: new Date(RESERVED_UNTIL.getTime() + 1000),
      }),
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.error.code).toBe('RESERVATION_EXPIRED');
    }
  });

  it('生きている支払い口があれば、それを使い回す', () => {
    // ⚠️ 押すたびに作ると、同じ注文の口が複数生き、両方で払える。
    const existing = session();
    const decision = decideCheckout(
      input({
        orderStatus: 'checkout_created',
        paymentStatus: 'pending',
        existingSession: existing,
      }),
    );
    expect(decision.ok).toBe(true);
    if (decision.ok && decision.value.kind === 'reuse') {
      expect(decision.value.session.sessionRef).toBe('cs_test_1');
    } else {
      throw new Error('reuse になるはず');
    }
  });

  it('期限切れの支払い口は使い回さない', () => {
    const decision = decideCheckout(
      input({
        orderStatus: 'checkout_created',
        paymentStatus: 'pending',
        existingSession: session({ expiresAt: new Date(NOW.getTime() - 1000) }),
      }),
    );
    expect(decision.ok && decision.value.kind).toBe('create');
  });

  it('新しい口の期限は、お取り置きの期限を超えない', () => {
    // ⚠️ 超えると、在庫を解放したあとに支払えてしまう。
    const decision = decideCheckout(input());
    if (decision.ok && decision.value.kind === 'create') {
      expect(decision.value.expiresAt.getTime()).toBeLessThanOrEqual(RESERVED_UNTIL.getTime());
    } else {
      throw new Error('create になるはず');
    }
  });
});

describe('支払い口が使えるかの判定', () => {
  it('pending で URL があり、期限内なら使える', () => {
    expect(isSessionUsable(session(), NOW)).toBe(true);
  });

  it('失敗・取消の口は使わない', () => {
    for (const status of ['failed', 'cancelled', 'succeeded', 'refunded'] as const) {
      expect(isSessionUsable(session({ status }), NOW)).toBe(false);
    }
  });

  it('URL が無ければ使わない', () => {
    expect(isSessionUsable(session({ url: null }), NOW)).toBe(false);
    expect(isSessionUsable(session({ url: '' }), NOW)).toBe(false);
  });
});

describe('決済事業者の知らせと注文の突き合わせ', () => {
  function fact(overrides: Partial<ProviderPaymentFact> = {}): ProviderPaymentFact {
    return {
      kind: 'succeeded',
      eventId: 'evt_1',
      eventType: 'checkout.session.completed',
      apiVersion: '2026-07-29.dahlia',
      livemode: false,
      orderId: 'order-1',
      sessionRef: 'cs_test_1',
      paymentRef: 'pi_test_1',
      chargeRef: null,
      amount: 12000,
      currency: 'jpy',
      failureCode: null,
      refundRef: null,
      refundedTotal: null,
      disputeRef: null,
      disputeStatus: null,
      disputeAmount: null,
      disputeReason: null,
      disputeEvidenceDueAt: null,
      occurredAt: NOW,
      credentialId: 'cred-1',
      ...overrides,
    };
  }

  function expectation(overrides: Partial<OrderPaymentExpectation> = {}): OrderPaymentExpectation {
    return {
      orderId: 'order-1',
      totalAmount: 12000,
      currency: 'JPY',
      sessionRef: 'cs_test_1',
      paymentRef: 'pi_test_1',
      hasSucceededPayment: false,
      ...overrides,
    };
  }

  it('すべて一致すれば通る', () => {
    expect(verifyPaymentFact(fact(), expectation()).ok).toBe(true);
  });

  it('通貨は大文字小文字をそろえて比べる', () => {
    // Stripe は小文字で返す。ここで落とすと、正しい決済が確定しない。
    expect(verifyPaymentFact(fact({ currency: 'JPY' }), expectation()).ok).toBe(true);
  });

  it('注文IDが違えば確定しない', () => {
    const result = verifyPaymentFact(fact({ orderId: 'order-2' }), expectation());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PAYMENT_MISMATCH');
  });

  it('注文IDが無ければ確定しない', () => {
    expect(verifyPaymentFact(fact({ orderId: null }), expectation()).ok).toBe(false);
  });

  it('金額が違えば確定しない', () => {
    // ⚠️ ここが抜けると、少ない入金で商品を渡すことになる。
    expect(verifyPaymentFact(fact({ amount: 1 }), expectation()).ok).toBe(false);
    expect(verifyPaymentFact(fact({ amount: null }), expectation()).ok).toBe(false);
  });

  it('通貨が違えば確定しない', () => {
    expect(verifyPaymentFact(fact({ currency: 'usd' }), expectation()).ok).toBe(false);
    expect(verifyPaymentFact(fact({ currency: null }), expectation()).ok).toBe(false);
  });

  it('支払い口が違えば確定しない', () => {
    // 別の注文のために作った口の成功で、この注文を確定させない。
    expect(verifyPaymentFact(fact({ sessionRef: 'cs_other' }), expectation()).ok).toBe(false);
    expect(verifyPaymentFact(fact({ paymentRef: 'pi_other' }), expectation()).ok).toBe(false);
  });

  it('こちらがまだ識別子を持っていなければ、その照合は飛ばす', () => {
    // 口を作った直後に落ちた場合。他の照合はすべて通っている。
    const result = verifyPaymentFact(fact(), expectation({ sessionRef: null, paymentRef: null }));
    expect(result.ok).toBe(true);
  });

  it('相手が識別子を返さないイベントでも、他が合えば通る', () => {
    // Payment Intent 側のイベントには Session の識別子が無い。
    expect(verifyPaymentFact(fact({ sessionRef: null }), expectation()).ok).toBe(true);
  });
});

describe('本番と試験の取り違え', () => {
  it('livemode が食い違えば知らせる', () => {
    // ⚠️ 見ないと、テストの知らせで本番の注文が確定する。
    const base = {
      kind: 'succeeded' as const,
      eventId: 'evt_1',
      eventType: 'x',
      apiVersion: null,
      orderId: null,
      sessionRef: null,
      paymentRef: null,
      chargeRef: null,
      amount: null,
      currency: null,
      failureCode: null,
      refundRef: null,
      refundedTotal: null,
      disputeRef: null,
      disputeStatus: null,
      disputeAmount: null,
      disputeReason: null,
      disputeEvidenceDueAt: null,
      occurredAt: NOW,
      credentialId: null,
    };
    expect(isLivemodeConsistent({ ...base, livemode: false }, false)).toBe(true);
    expect(isLivemodeConsistent({ ...base, livemode: true }, false)).toBe(false);
    expect(isLivemodeConsistent({ ...base, livemode: false }, true)).toBe(false);
  });
});

describe('失敗理由の畳み込み', () => {
  it('知っている符号はそのまま通す', () => {
    expect(toSafeFailureCode('card_declined')).toBe('card_declined');
  });

  it('知らない符号は unknown にする', () => {
    // カードの事情（盗難届など）を保存しない。
    expect(toSafeFailureCode('stolen_card')).toBe('unknown');
    expect(toSafeFailureCode(null)).toBe('unknown');
    expect(toSafeFailureCode('')).toBe('unknown');
  });
});
