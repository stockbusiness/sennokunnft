import { describe, expect, it } from 'vitest';
import { decideRefund, refundStatusAfter, type RefundEligibilityInput } from '../src/order/refund';

/**
 * 返金してよいかの判定（`UD-104`。決定 2026-08-20）。
 *
 * ⚠️ ここで守りたいのは 4 つ。
 *   1. **期限は注文へ焼き付けた値だけを見ること。** 設定を読むと、
 *      日数を延ばした瞬間に精算済みの注文が「まだ返金できる」に化ける。
 *   2. **こちらの落ち度を期限で断らないこと。**
 *   3. **`processing` を取り消さないこと**（`INV-M4`）。外部へ送信済みの
 *      可能性があり、多重発行は回復できない。
 *   4. **「機械が決めない」を「できない」にしないこと。** 発行済みでも、
 *      事業の判断で返すことはある。
 */

const NOW = new Date('2026-08-20T00:00:00.000Z');

const BASE: RefundEligibilityInput = {
  paymentStatus: 'succeeded',
  refundStatus: 'none',
  refundableUntil: new Date('2026-09-03T00:00:00.000Z'),
  entitlementStatus: 'issued',
  mintStatus: null,
  reason: 'buyer_request',
  // ⚠️ 既定は偽。設定していない配備の振る舞いを変えないことを前提にする。
  revokeClaimedEntitlements: false,
  now: NOW,
};

function decide(overrides: Partial<RefundEligibilityInput>) {
  return decideRefund({ ...BASE, ...overrides });
}

describe('decideRefund — 断る場合', () => {
  it('お支払いが済んでいなければ返金しない', () => {
    for (const paymentStatus of ['pending', 'failed', 'cancelled'] as const) {
      const result = decide({ paymentStatus });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('REFUND_NOT_ALLOWED');
      }
    }
  });

  it('すでに全額返している注文を二度通さない', () => {
    // ⚠️ 通すと二重返金になる。取り返せない。
    const result = decide({ refundStatus: 'refunded' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('REFUND_ALREADY_DONE');
    }
  });

  it('一部返金済みなら、まだ受け付ける', () => {
    expect(decide({ refundStatus: 'partially_refunded' }).ok).toBe(true);
  });

  it('お申し出による返金は、期限を過ぎたら断る', () => {
    const result = decide({ now: new Date('2026-09-03T00:00:00.001Z') });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('REFUND_WINDOW_CLOSED');
    }
  });

  it('期限ちょうどは受け付ける（境界を閉じない）', () => {
    expect(decide({ now: new Date('2026-09-03T00:00:00.000Z') }).ok).toBe(true);
  });

  it('支払い済みなのに期限が無い記録は、黙って通さない', () => {
    // ⚠️ 「無いから通す」にすると、壊れた行がいちばん緩く扱われる。
    const result = decide({ refundableUntil: null });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('REFUND_NOT_ALLOWED');
    }
  });
});

describe('decideRefund — 期限を見ない理由', () => {
  it('当方の不具合は、期限を過ぎていても受け付ける', () => {
    /*
      ⚠️ 自社の落ち度に「14 日を過ぎたので対応できません」は通らない。
         期限が無い記録でも同じ。
    */
    expect(decide({ reason: 'our_fault', now: new Date('2027-01-01T00:00:00.000Z') }).ok).toBe(
      true,
    );
    expect(decide({ reason: 'our_fault', refundableUntil: null }).ok).toBe(true);
  });

  it('決済事業者の画面から返金された分も、期限を見ずに追随する', () => {
    // ⚠️ もう返金されている事実の記録。こちらの期限で断る意味が無い。
    expect(
      decide({ reason: 'provider_initiated', now: new Date('2027-01-01T00:00:00.000Z') }).ok,
    ).toBe(true);
  });
});

describe('decideRefund — 発行がどこまで進んだか', () => {
  it('まだ受け取っていなければ、受取権ごと取り消す', () => {
    const result = decide({ entitlementStatus: 'issued', mintStatus: null });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe('allowed');
      expect(result.value.effects).toEqual({
        revokeEntitlement: true,
        cancelMintJob: false,
        requiresManualReview: false,
      });
    }
  });

  it('受取り済みでも、切り替える前は取り消さない', () => {
    // 段階導入のため、既定では従来どおりの振る舞いを保つ。
    const result = decide({ entitlementStatus: 'claimed', mintStatus: null });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.effects.revokeEntitlement).toBe(false);
    }
  });

  it('切り替えると、受取り済みも取り消す（`UD-104` 追補）', () => {
    /*
      ⚠️ **「受け取った事実」と「いま使える権利」は別。** 全額返金が
         成立した以上、権利が使えるまま残るのは認めない。受け取った
         記録（`claimed_at` など）は消さない——消さないことは DB 側の
         試験で確かめる。
    */
    const result = decide({
      entitlementStatus: 'claimed',
      mintStatus: null,
      revokeClaimedEntitlements: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe('allowed');
      expect(result.value.effects.revokeEntitlement).toBe(true);
    }
  });

  it('切り替えても、発行処理中は取り消さない（`INV-M4`）', () => {
    // ⚠️ ここを緩めない。外部へ送信済みの可能性があり、多重発行は戻せない。
    const result = decide({
      entitlementStatus: 'claimed',
      mintStatus: 'processing',
      revokeClaimedEntitlements: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe('needs_review');
      expect(result.value.effects.revokeEntitlement).toBe(false);
    }
  });

  it('発行待ちなら、発行ジョブを取り消す', () => {
    const result = decide({ entitlementStatus: 'claimed', mintStatus: 'queued' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe('allowed');
      expect(result.value.effects.cancelMintJob).toBe(true);
    }
  });

  it('発行処理中は取り消さず、人の確認へ回す（`INV-M4`）', () => {
    /*
      ⚠️ 外部へ送信済みの可能性がある。取り消すと多重発行になり、
         これは回復できない。
    */
    const result = decide({ entitlementStatus: 'claimed', mintStatus: 'processing' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe('needs_review');
      expect(result.value.effects.cancelMintJob).toBe(false);
      expect(result.value.effects.revokeEntitlement).toBe(false);
      expect(result.value.effects.requiresManualReview).toBe(true);
    }
  });

  it('発行済みも人の確認へ回す。「返金できない」とは言わない', () => {
    const result = decide({ entitlementStatus: 'claimed', mintStatus: 'succeeded' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // ⚠️ `Err` ではない。回収できないだけで、返すかどうかは事業の判断。
      expect(result.value.kind).toBe('needs_review');
    }
  });

  it('発行に失敗した注文は、そのまま返金してよい', () => {
    const result = decide({ entitlementStatus: 'claimed', mintStatus: 'failed' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe('allowed');
      expect(result.value.effects.requiresManualReview).toBe(false);
    }
  });

  it('期限切れの受取権は取り消してよい', () => {
    const result = decide({ entitlementStatus: 'expired', mintStatus: null });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.effects.revokeEntitlement).toBe(true);
    }
  });
});

describe('refundStatusAfter', () => {
  it('全額返金で `refunded`', () => {
    expect(refundStatusAfter(3_000, 3_000)).toBe('refunded');
  });

  it('返金額が上回っても `refunded`（下回らせない）', () => {
    expect(refundStatusAfter(3_500, 3_000)).toBe('refunded');
  });

  it('一部なら `partially_refunded`', () => {
    expect(refundStatusAfter(1_000, 3_000)).toBe('partially_refunded');
  });

  it('0 円なら動かさない', () => {
    expect(refundStatusAfter(0, 3_000)).toBe('none');
  });
});
