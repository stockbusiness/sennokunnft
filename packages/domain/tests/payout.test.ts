import { describe, expect, it } from 'vitest';
import {
  buildPayoutDraft,
  canConfirmPayout,
  transitionPayoutStatus,
  type PayoutCandidate,
  type PayoutClawback,
  type PayoutDraftInput,
} from '../src/settlement/payout';
import { payoutPeriodOf } from '../src/settlement/period';

/**
 * 精算の組み立て（`UD-119`。決定 2026-08-20）。
 *
 * ⚠️ ここで守りたいのは 4 つ。
 *   1. **繰越を足してから最低支払額と比べること。** 先に比べると、毎月
 *      900 円の作家さまが永久に受け取れない。
 *   2. **差し戻しを明細に載せること。** 合計だけ減らすと、作家さまが
 *      「なぜ今月は少ないのか」を読み取れない。
 *   3. **返金の窓が閉じるまで確定しないこと**（`SETTLEMENT_AND_REFUND.md` §2-3）。
 *   4. **`confirmed` から `draft` へ戻れないこと。** 戻せると、明細を渡した
 *      あとに金額を変える道ができる。
 */

const PERIOD = payoutPeriodOf(2026, 8);
const NOW = new Date('2026-09-20T00:00:00.000Z');
/** 窓が閉じた注文。⚠️ `now` より前。 */
const CLOSED = new Date('2026-09-01T00:00:00.000Z');

function candidate(overrides: Partial<PayoutCandidate> = {}): PayoutCandidate {
  return {
    orderId: 'order-1',
    orderNumber: 'SNK-0001',
    creatorAccountId: 'creator-1',
    artworkTitleSnapshot: '天下布武の陣羽織',
    paidAt: new Date('2026-08-10T00:00:00.000Z'),
    grossAmount: 12000,
    feeRateBps: 2000,
    feeAmount: 2400,
    netAmount: 9600,
    refundableUntil: CLOSED,
    isUnderDispute: false,
    ...overrides,
  };
}

function draft(overrides: Partial<PayoutDraftInput> = {}) {
  return buildPayoutDraft({
    period: PERIOD,
    creatorAccountId: 'creator-1',
    candidates: [],
    clawbacks: [],
    carriedInAmount: 0,
    minimumPayoutAmount: 1000,
    transferFeeBearer: 'creator',
    now: NOW,
    ...overrides,
  });
}

describe('集計', () => {
  it('販売額・手数料・お支払額を合計する', () => {
    const result = draft({
      candidates: [candidate(), candidate({ orderId: 'order-2', orderNumber: 'SNK-0002' })],
    });
    expect(result.grossAmount).toBe(24000);
    expect(result.feeAmount).toBe(4800);
    expect(result.netAmount).toBe(19200);
    expect(result.lines).toHaveLength(2);
  });

  it('明細は注文ごとに 1 行（丸めない）', () => {
    // ⚠️ 「注文ごとに」が仕様（`SETTLEMENT_AND_REFUND.md` §2-2）。
    const result = draft({ candidates: [candidate(), candidate({ orderId: 'order-2' })] });
    expect(result.lines.map((line) => line.orderId)).toEqual(['order-1', 'order-2']);
  });

  it('売上が無くても組み立てられる（繰越だけの月）', () => {
    const result = draft({ carriedInAmount: 5000 });
    expect(result.netAmount).toBe(5000);
    expect(result.lines).toHaveLength(0);
  });
});

describe('最低支払額と繰越', () => {
  it('満たなければ払わず、全額を翌月へ送る', () => {
    const result = draft({
      candidates: [candidate({ grossAmount: 1000, feeAmount: 200, netAmount: 800 })],
      minimumPayoutAmount: 1000,
    });
    expect(result.netAmount).toBe(0);
    expect(result.carriedOutAmount).toBe(800);
  });

  it('繰越を足してから比べる', () => {
    /*
      ⚠️ **先に比べると、毎月 900 円の作家さまが永久に受け取れない。**
         繰り越しても足し合わせないなら、繰越は死んだ数字になる。
    */
    const result = draft({
      candidates: [candidate({ netAmount: 800 })],
      carriedInAmount: 800,
      minimumPayoutAmount: 1000,
    });
    expect(result.netAmount).toBe(1600);
    expect(result.carriedOutAmount).toBe(0);
  });

  it('ちょうど最低支払額なら払う（境界を閉じない）', () => {
    const result = draft({
      candidates: [candidate({ netAmount: 1000 })],
      minimumPayoutAmount: 1000,
    });
    expect(result.netAmount).toBe(1000);
  });

  it('最低支払額 0 でも、0 円は払わない', () => {
    // ⚠️ 0 円の振込は起こさない。振込手数料だけが出ていく。
    const result = draft({ minimumPayoutAmount: 0 });
    expect(result.netAmount).toBe(0);
    expect(result.carriedOutAmount).toBe(0);
  });
});

describe('差し戻し（確定済みの精算に載った注文の返金）', () => {
  const clawback: PayoutClawback = {
    orderId: 'order-old',
    orderNumber: 'SNK-0000',
    artworkTitleSnapshot: '前月の作品',
    netAmount: 9600,
  };

  it('明細にマイナスの行として載る', () => {
    /*
      ⚠️ **合計だけ減らさない。** 作家さまが「なぜ今月は少ないのか」を
         明細から読み取れないと、必ず問い合わせになる。
    */
    const result = draft({ candidates: [candidate()], clawbacks: [clawback] });
    const line = result.lines.find((row) => row.isClawback);
    expect(line?.netAmount).toBe(-9600);
    // ⚠️ 販売額には積まない。二重に数えることになる。
    expect(line?.grossAmount).toBe(0);
    expect(result.grossAmount).toBe(12000);
  });

  it('お支払額から差し引く', () => {
    const result = draft({ candidates: [candidate()], clawbacks: [clawback] });
    expect(result.refundedAmount).toBe(9600);
    expect(result.netAmount).toBe(0);
  });

  it('差し引ききれない分はマイナスの繰越として持ち越す', () => {
    /*
      ⚠️ **0 に丸めない。** 丸めると、差し戻しがそのまま消える——つまり
         返金した額を運営が被る。翌月以降で回収する。
    */
    const result = draft({
      candidates: [candidate({ netAmount: 1000 })],
      clawbacks: [clawback],
    });
    expect(result.netAmount).toBe(0);
    expect(result.carriedOutAmount).toBe(-8600);
  });

  it('マイナスの繰越は、翌月の売上から引かれる', () => {
    const result = draft({
      candidates: [candidate({ netAmount: 9600 })],
      carriedInAmount: -8600,
    });
    expect(result.netAmount).toBe(1000);
  });
});

describe('返金の窓が閉じるまで確定しない', () => {
  it('窓が開いている注文があれば数える', () => {
    const result = draft({
      candidates: [
        candidate(),
        // ⚠️ `now` より後 = まだ返金されうる。
        candidate({ orderId: 'order-2', refundableUntil: new Date('2026-09-25T00:00:00.000Z') }),
      ],
    });
    expect(result.openRefundWindows).toBe(1);
  });

  it('期限が付いていない注文は「閉じた」とみなさない', () => {
    /*
      ⚠️ **分からないものを、分かったことにしない。** 期限の列より前に
         支払われた注文が該当する。閉じた扱いにすると、まだ返金されうる
         注文を確定してしまう。
    */
    const result = draft({ candidates: [candidate({ refundableUntil: null })] });
    expect(result.openRefundWindows).toBe(1);
  });

  it('境界のちょうどは閉じている', () => {
    const result = draft({ candidates: [candidate({ refundableUntil: NOW })] });
    expect(result.openRefundWindows).toBe(0);
  });

  it('窓が開いていれば確定できない', () => {
    const result = canConfirmPayout({
      ...draft({ candidates: [candidate({ refundableUntil: null })] }),
      openDisputes: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PAYOUT_WINDOW_OPEN');
    }
  });

  it('すべて閉じていれば確定できる', () => {
    expect(canConfirmPayout({ ...draft({ candidates: [candidate()] }), openDisputes: 0 }).ok).toBe(
      true,
    );
  });

  it('0 円の精算も確定できる（繰越だけの月）', () => {
    // ⚠️ 「払う額が無い」ことと「まだ締められない」ことは別。
    expect(canConfirmPayout({ ...draft(), openDisputes: 0 }).ok).toBe(true);
  });
});

describe('焼き付け', () => {
  it('そのときの最低支払額と振込手数料の負担を持つ', () => {
    /*
      ⚠️ **あとから設定を変えても、この精算は動かない**
         （`SETTLEMENT_AND_REFUND.md` §0 の三層のうち②）。
    */
    const result = draft({ minimumPayoutAmount: 3000, transferFeeBearer: 'platform' });
    expect(result.minimumPayoutAmount).toBe(3000);
    expect(result.transferFeeBearer).toBe('platform');
  });
});

describe('状態', () => {
  it('下書きは作り直せる', () => {
    expect(transitionPayoutStatus('draft', 'draft').ok).toBe(true);
  });

  it('確定してから支払い済みへ進む', () => {
    expect(transitionPayoutStatus('draft', 'confirmed').ok).toBe(true);
    expect(transitionPayoutStatus('confirmed', 'paid').ok).toBe(true);
  });

  it('確定から下書きへ戻せない', () => {
    /*
      ⚠️ **戻せると、明細を渡したあとに金額を変える道ができる。**
         訂正は次の期間での調整で行う。
    */
    const result = transitionPayoutStatus('confirmed', 'draft');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PAYOUT_NOT_EDITABLE');
    }
  });

  it('下書きから支払い済みへ飛ばせない', () => {
    expect(transitionPayoutStatus('draft', 'paid').ok).toBe(false);
  });

  it('支払い済みは終着', () => {
    expect(transitionPayoutStatus('paid', 'confirmed').ok).toBe(false);
    expect(transitionPayoutStatus('paid', 'paid').ok).toBe(false);
  });
});

/*
  決着待ちのご注文を外す（決定 B・2026-08-22）。

  ⚠️ ここで守りたいのは 3 つ。
    1. **外したぶんが合計に入らないこと。** 入ると、争いの最中の注文まで
       お支払いしてしまう。
    2. **外した件数と額が残ること。** 残らないと、作家さまが「なぜ今月は
       少ないのか」を読めない。
    3. **外した注文の返金の窓で確定が止まらないこと。** 止まると、争いの
       ある注文のせいで精算が確定できず、B にした意味が消える。
*/
describe('決着待ちのご注文', () => {
  it('争いのあるご注文は合計に入らない', () => {
    const result = draft({
      candidates: [
        candidate(),
        candidate({ orderId: 'order-2', orderNumber: 'SNK-0002', isUnderDispute: true }),
      ],
    });
    // ⚠️ 1 件ぶんだけ。2 件ぶん（24000 / 4800 / 19200）になってはいけない。
    expect(result.grossAmount).toBe(12000);
    expect(result.feeAmount).toBe(2400);
    expect(result.netAmount).toBe(9600);
  });

  it('争いのあるご注文は明細にも載らない', () => {
    const result = draft({
      candidates: [
        candidate(),
        candidate({ orderId: 'order-2', orderNumber: 'SNK-0002', isUnderDispute: true }),
      ],
    });
    expect(result.lines).toHaveLength(1);
    expect(result.lines.map((line) => line.orderId)).toEqual(['order-1']);
  });

  it('外した件数と額が残る', () => {
    /*
      ⚠️ **合計だけ減らして理由を残さないと、作家さまが読めない。**
         差し戻しを明細に載せているのと同じ理由である。
    */
    const result = draft({
      candidates: [
        candidate(),
        candidate({ orderId: 'order-2', orderNumber: 'SNK-0002', isUnderDispute: true }),
        candidate({ orderId: 'order-3', orderNumber: 'SNK-0003', isUnderDispute: true }),
      ],
    });
    expect(result.deferredDisputeCount).toBe(2);
    expect(result.deferredDisputeAmount).toBe(19200);
  });

  it('争いが無ければ 0 件・0 円', () => {
    const result = draft({ candidates: [candidate()] });
    expect(result.deferredDisputeCount).toBe(0);
    expect(result.deferredDisputeAmount).toBe(0);
  });

  it('外したご注文の返金の窓では確定が止まらない', () => {
    /*
      ⚠️ **これが本題である。** 外した注文の窓まで数えると、争いのある
         注文のせいで確定できない精算ができ、B にした意味が消える。
    */
    const result = draft({
      candidates: [
        candidate(),
        candidate({
          orderId: 'order-2',
          orderNumber: 'SNK-0002',
          isUnderDispute: true,
          // ⚠️ `now` より後 = まだ開いている窓。
          refundableUntil: new Date('2026-10-01T00:00:00.000Z'),
        }),
      ],
    });
    expect(result.openRefundWindows).toBe(0);
    expect(canConfirmPayout({ ...result, openDisputes: 0 }).ok).toBe(true);
  });

  it('全部が争いなら、お支払いは 0 円になる', () => {
    /*
      ⚠️ **0 円でも確定してよい。** 「払う額が無い」ことと「まだ締められない」
         ことは別。止めると、翌月の繰越が積み上がって話が複雑になる。
    */
    const result = draft({
      candidates: [candidate({ isUnderDispute: true })],
    });
    expect(result.netAmount).toBe(0);
    expect(result.deferredDisputeCount).toBe(1);
    expect(canConfirmPayout({ ...result, openDisputes: 0 }).ok).toBe(true);
  });

  it('下書きを作ったあとに争いが起きたら、確定を止める', () => {
    /*
      ⚠️ **ここは残す。** 下書きの時点では争いが無かった注文が、確定までの
         あいだに争いになることがある。そのまま確定すると、争いの最中の
         注文をお支払いしてしまう。作り直せば外れる。
    */
    const result = canConfirmPayout({
      ...draft({ candidates: [candidate()] }),
      openDisputes: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PAYOUT_DISPUTE_OPEN');
    }
  });
});
