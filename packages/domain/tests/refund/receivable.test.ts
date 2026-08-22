import { describe, expect, it } from 'vitest';
import { outstandingTotal, planClawback } from '../../src/refund/receivable';

/**
 * 作家さまからの回収待ち（方針整理 2026-08-22）。
 *
 * ⚠️ **この組の主題は 3 つ。**
 *  1. **支払い前なら回収待ちにしない**（渡していないものを「返して」と言わない）
 *  2. 差し引ける分は差し引き、**引ききれない分だけ**を回収待ちにする
 *  3. 諦めた額も**消さずに残す**
 */
describe('支払い後の返金をどう扱うか', () => {
  /*
    ⚠️ **まだ精算に載っていない／下書きのまま＝確定前の売上。** 取り消せば
       済む。回収待ちにすると、渡していないお金を「返してもらう」ことになる。
  */
  it('精算に載っていなければ、確定前の売上を取り消すだけ', () => {
    expect(
      planClawback({ creatorAmount: 9600, payoutStatus: null, upcomingPayableAmount: 0 }),
    ).toEqual({ kind: 'cancel_pending', amount: 9600 });
  });

  it('下書きのままでも、確定前の売上を取り消すだけ', () => {
    expect(
      planClawback({ creatorAmount: 9600, payoutStatus: 'draft', upcomingPayableAmount: 0 }),
    ).toEqual({ kind: 'cancel_pending', amount: 9600 });
  });

  /*
    ⚠️ **確定済み（未払い）も、次回で差し引ける。** 確定は「払う」と決めた
       だけで、まだ渡していない。
  */
  it('次回で差し引けるなら、回収待ちにしない', () => {
    expect(
      planClawback({
        creatorAmount: 9600,
        payoutStatus: 'confirmed',
        upcomingPayableAmount: 20_000,
      }),
    ).toEqual({ kind: 'offset_next', amount: 9600 });
  });

  it('ちょうど足りるなら、差し引きで済む', () => {
    expect(
      planClawback({ creatorAmount: 9600, payoutStatus: 'paid', upcomingPayableAmount: 9600 }),
    ).toEqual({ kind: 'offset_next', amount: 9600 });
  });

  /*
    ⚠️ **差し引ききれない分だけを回収待ちにする。** 全額を回収待ちに
       すると、差し引ける分まで二重に取ることになる。
  */
  it('引ききれない分だけを回収待ちにする', () => {
    expect(
      planClawback({ creatorAmount: 9600, payoutStatus: 'paid', upcomingPayableAmount: 4000 }),
    ).toEqual({ kind: 'receivable', amount: 5600 });
  });

  it('次回の見込みが無ければ、全額が回収待ち', () => {
    expect(
      planClawback({ creatorAmount: 9600, payoutStatus: 'paid', upcomingPayableAmount: 0 }),
    ).toEqual({ kind: 'receivable', amount: 9600 });
  });

  /** ⚠️ 見込みがマイナス（すでに繰越の借り）でも、二重に足さない。 */
  it('見込みがマイナスでも、返金額を超えて回収しない', () => {
    expect(
      planClawback({ creatorAmount: 9600, payoutStatus: 'paid', upcomingPayableAmount: -5000 }),
    ).toEqual({ kind: 'receivable', amount: 9600 });
  });
});

describe('残高', () => {
  const row = (amount: number, status: 'outstanding' | 'settled' | 'written_off' | 'offset') => ({
    id: `r-${String(amount)}-${status}`,
    creatorAccountId: 'creator-1',
    orderId: 'order-1',
    amount,
    status,
    createdAt: new Date('2026-08-22T00:00:00.000Z'),
    // ⚠️ 決着したものだけ時刻が入る（`outstanding` は `null`）。
    settledAt: status === 'outstanding' ? null : new Date('2026-08-23T00:00:00.000Z'),
  });

  /*
    ⚠️ **残っているものだけを足す。** 諦めた分（`written_off`）を足すと、
       いつまでも取り立てているように見える。
  */
  it('残っている分だけを足す', () => {
    expect(
      outstandingTotal([
        row(5000, 'outstanding'),
        row(3000, 'outstanding'),
        row(9999, 'settled'),
        row(8888, 'written_off'),
        row(7777, 'offset'),
      ]),
    ).toBe(8000);
  });

  it('何も残っていなければ 0', () => {
    expect(outstandingTotal([row(9999, 'settled')])).toBe(0);
  });
});
