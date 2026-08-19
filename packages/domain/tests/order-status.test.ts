import { describe, expect, it } from 'vitest';
import {
  FULFILLMENT_STATUSES,
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  REFUND_STATUSES,
  isOrderFinal,
  transitionFulfillmentStatus,
  transitionOrderStatus,
  transitionPaymentStatus,
  transitionRefundStatus,
} from '../src/index';

/**
 * 注文まわりの状態遷移（指示書 §7）。
 *
 * ⚠️ **この試験の主題は「通ってはいけない遷移が通らないこと」。**
 * 「進める」より「戻れない・飛べない」を厚く見る。
 * 飛べてしまう遷移は、そのまま業務の穴になる。
 */

/** 総当たりで、表に無い遷移がすべて拒否されることを確かめる。 */
function assertOnlyAllowed<S extends string>(
  statuses: readonly S[],
  allowed: ReadonlyArray<readonly [S, S]>,
  transition: (from: S, to: S) => { ok: boolean },
): void {
  const allowedSet = new Set(allowed.map(([from, to]) => `${from}->${to}`));
  for (const from of statuses) {
    for (const to of statuses) {
      const expected = allowedSet.has(`${from}->${to}`);
      expect(transition(from, to).ok, `${from} -> ${to}`).toBe(expected);
    }
  }
}

describe('注文の進み具合', () => {
  it('表にある遷移だけが通る', () => {
    assertOnlyAllowed(
      ORDER_STATUSES,
      [
        ['pending', 'checkout_created'],
        ['pending', 'expired'],
        ['pending', 'cancelled'],
        ['checkout_created', 'paid'],
        ['checkout_created', 'expired'],
        ['checkout_created', 'cancelled'],
      ],
      transitionOrderStatus,
    );
  });

  /*
    ⚠️ **ここが本丸。** 支払い済みの注文を期限切れにできると、
       お金を受け取ったあとに在庫を戻すことになる。売った物が消える。
  */
  it('支払い済みからは、期限切れにも取消にもできない', () => {
    expect(transitionOrderStatus('paid', 'expired').ok).toBe(false);
    expect(transitionOrderStatus('paid', 'cancelled').ok).toBe(false);
  });

  it('決済は Checkout を作ってからしか成立しない', () => {
    // ⚠️ `pending` から直接 `paid` へ飛べると、Checkout を経ずに
    //    支払い済みにできる経路ができる。
    expect(transitionOrderStatus('pending', 'paid').ok).toBe(false);
  });

  it('同じ状態への遷移も通らない', () => {
    // 「すでにその状態」は遷移ではない。ここで許すと、
    // 二重処理が「1 回目」として通ってしまう。
    for (const status of ORDER_STATUSES) {
      expect(transitionOrderStatus(status, status).ok).toBe(false);
    }
  });

  it('終端が正しい', () => {
    expect(isOrderFinal('paid')).toBe(true);
    expect(isOrderFinal('expired')).toBe(true);
    expect(isOrderFinal('cancelled')).toBe(true);
    expect(isOrderFinal('pending')).toBe(false);
    expect(isOrderFinal('checkout_created')).toBe(false);
  });

  it('拒否の符号は固定', () => {
    const result = transitionOrderStatus('paid', 'expired');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ORDER_TRANSITION_NOT_ALLOWED');
  });
});

describe('決済の状態', () => {
  it('表にある遷移だけが通る', () => {
    assertOnlyAllowed(
      PAYMENT_STATUSES,
      [
        ['not_started', 'pending'],
        ['not_started', 'cancelled'],
        ['pending', 'succeeded'],
        ['pending', 'failed'],
        ['pending', 'cancelled'],
        ['succeeded', 'refunded'],
      ],
      transitionPaymentStatus,
    );
  });

  /*
    ⚠️ **成功から失敗へ戻さない。** 決済事業者側で成功した事実は消えない。
       取り消したいときは返金で表す。戻せると、返金の記録を残さずに
       「無かったこと」にできてしまう。
  */
  it('成功したものを失敗・取消へ戻せない', () => {
    expect(transitionPaymentStatus('succeeded', 'failed').ok).toBe(false);
    expect(transitionPaymentStatus('succeeded', 'cancelled').ok).toBe(false);
    expect(transitionPaymentStatus('succeeded', 'pending').ok).toBe(false);
  });
});

describe('付与の状態', () => {
  it('表にある遷移だけが通る', () => {
    assertOnlyAllowed(
      FULFILLMENT_STATUSES,
      [
        ['not_started', 'processing'],
        ['processing', 'fulfilled'],
        ['processing', 'failed'],
        ['failed', 'processing'],
      ],
      transitionFulfillmentStatus,
    );
  });

  /*
    ⚠️ **失敗を終端にしない。** 付与の失敗は運用で直せるもの。
       終端にすると、直せるものが直せなくなる。
  */
  it('失敗から再処理へ戻せる', () => {
    expect(transitionFulfillmentStatus('failed', 'processing').ok).toBe(true);
  });

  it('付与済みからは動かない', () => {
    for (const to of FULFILLMENT_STATUSES) {
      expect(transitionFulfillmentStatus('fulfilled', to).ok).toBe(false);
    }
  });
});

describe('返金の状態', () => {
  it('表にある遷移だけが通る', () => {
    assertOnlyAllowed(
      REFUND_STATUSES,
      [
        ['none', 'pending'],
        ['pending', 'partially_refunded'],
        ['pending', 'refunded'],
        ['pending', 'failed'],
        ['partially_refunded', 'pending'],
        ['partially_refunded', 'refunded'],
        ['failed', 'pending'],
      ],
      transitionRefundStatus,
    );
  });

  it('全額返金からは動かない', () => {
    for (const to of REFUND_STATUSES) {
      expect(transitionRefundStatus('refunded', to).ok).toBe(false);
    }
  });

  it('一部返金から全額返金へ進める', () => {
    expect(transitionRefundStatus('partially_refunded', 'refunded').ok).toBe(true);
  });
});
