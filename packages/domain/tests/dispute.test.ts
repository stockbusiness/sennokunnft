import { describe, expect, it } from 'vitest';
import {
  DISPUTE_STATUSES,
  canAdvanceDispute,
  disputeOutcome,
  isDisputeClosed,
  isDisputeOpen,
  shouldRecordRefund,
  toSafeDisputeReason,
  type DisputeStatus,
} from '../src/index';

describe('争いの状態', () => {
  /*
    ⚠️ **数を書いておく。** 状態を足すのは「精算を止める条件が変わる」
       ということ。ここが落ちて手が止まるのは、そのための仕掛けである。
  */
  it('状態は 5 つ', () => {
    expect(DISPUTE_STATUSES).toHaveLength(5);
  });

  it('警告は「争い」に数えない', () => {
    /*
      ⚠️ **カード会社が調べ始めただけ。** 申し立てにならずに消えることも
         ある。数えると、消えた警告のぶんまで精算を止め、作家さまへの
         お支払いが理由なく遅れる。
    */
    expect(disputeOutcome('warning')).toBe('warning');
    expect(isDisputeOpen('warning')).toBe(false);
    expect(isDisputeClosed('warning')).toBe(false);
  });

  it('申し立てと審理は「開いている」', () => {
    expect(isDisputeOpen('needs_response')).toBe(true);
    expect(isDisputeOpen('under_review')).toBe(true);
  });

  it('勝ち負けは「決着」', () => {
    expect(isDisputeClosed('won')).toBe(true);
    expect(isDisputeClosed('lost')).toBe(true);
    expect(isDisputeOpen('won')).toBe(false);
    expect(isDisputeOpen('lost')).toBe(false);
  });
});

describe('返金として記録するか', () => {
  it('敗訴のときだけ', () => {
    /*
      ⚠️ **争いが起きただけでは返金ではない。** 申し立てで受取権を
         取り消すと、こちらが勝ったときに取り上げたものを返せない
         ——外部のウォレットへ渡したものは、こちらからは戻せない。
    */
    expect(shouldRecordRefund('lost')).toBe(true);
    for (const status of ['warning', 'needs_response', 'under_review', 'won'] as const) {
      expect(shouldRecordRefund(status)).toBe(false);
    }
  });
});

describe('状態を進めてよいか', () => {
  it('申し立て → 審理 → 決着 は進める', () => {
    expect(canAdvanceDispute('warning', 'needs_response').ok).toBe(true);
    expect(canAdvanceDispute('needs_response', 'under_review').ok).toBe(true);
    expect(canAdvanceDispute('under_review', 'lost').ok).toBe(true);
    expect(canAdvanceDispute('needs_response', 'won').ok).toBe(true);
  });

  it('決着からは戻さない', () => {
    /*
      ⚠️ **事業者の知らせは前後して届く。** `closed` のあとに `created` が
         届いたとき、素直に上書きすると決着した争いが開き直り、精算が
         理由なく止まり続ける。
    */
    for (const closed of ['won', 'lost'] as const) {
      for (const to of ['warning', 'needs_response', 'under_review'] as const) {
        const result = canAdvanceDispute(closed, to);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('DISPUTE_NOT_ACTIONABLE');
        }
      }
    }
    expect(canAdvanceDispute('lost', 'won').ok).toBe(false);
    expect(canAdvanceDispute('won', 'lost').ok).toBe(false);
  });

  it('警告へは戻さない', () => {
    /*
      ⚠️ **申し立てを受けたあとに警告の知らせが遅れて届くことがある。**
         戻すと「まだ争いではない」ことになり、精算の歯止めが外れる。
    */
    expect(canAdvanceDispute('needs_response', 'warning').ok).toBe(false);
    expect(canAdvanceDispute('under_review', 'warning').ok).toBe(false);
  });

  it('同じ状態への更新は通す', () => {
    // ⚠️ 再送で落ちる形にすると、事業者へ 5xx を返し続けることになる。
    for (const status of DISPUTE_STATUSES) {
      expect(canAdvanceDispute(status, status).ok).toBe(true);
    }
  });
});

describe('争いの理由', () => {
  it('知らない値は `unknown` にする', () => {
    // ⚠️ 事業者の文字列をそのまま保存しない。カード会社の事情はこちらの語彙ではない。
    expect(toSafeDisputeReason('card_was_stolen_probably')).toBe('unknown');
    expect(toSafeDisputeReason(null)).toBe('unknown');
    expect(toSafeDisputeReason(undefined)).toBe('unknown');
  });

  it('知っている値はそのまま通す', () => {
    expect(toSafeDisputeReason('fraudulent')).toBe('fraudulent');
    expect(toSafeDisputeReason('product_not_received')).toBe('product_not_received');
  });
});

describe('すべての状態に決着の判定がある', () => {
  it('取りこぼしが無い', () => {
    // ⚠️ 状態を足したのに判定を足し忘れると、ここで気づく。
    for (const status of DISPUTE_STATUSES satisfies readonly DisputeStatus[]) {
      const outcome = disputeOutcome(status);
      expect(['warning', 'open', 'won', 'lost']).toContain(outcome);
    }
  });
});
