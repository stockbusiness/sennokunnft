/**
 * 作家さまからの回収待ち（方針整理 2026-08-22）。
 *
 * **支払ったあとに返金されたら、そのぶんは次回の支払額から差し引く。**
 * 差し引ききれなければ、**回収待ちとして残す**——残さないと、こちらが
 * 損を被ったのか、作家さまが払い戻すべきなのかが分からなくなる。
 *
 * ⚠️ **これは請求書ではない。** 記録であって、取り立ての仕組みではない。
 * どう回収するか（次回で相殺する／振込を依頼する／諦める）は人が決める。
 *
 * ⚠️ **既存の繰越（`carried_out_amount`）を置き換えない。** あちらは
 * 「精算 1 件のなかで引ききれなかった額」で、こちらは
 * **「精算をまたいで残っている額」**である。両方あってよい。
 */

/** 回収待ちの状態。⚠️ 語彙を閉じる。 */
export const RECEIVABLE_STATUSES = [
  /** 残っている。 */
  'outstanding',
  /** 次回以降の精算で差し引いた。 */
  'offset',
  /** 作家さまからお支払いいただいた。 */
  'settled',
  /**
   * 回収しないと決めた。
   *
   * ⚠️ **消さずに残す。** 消すと「いくら諦めたか」が分からなくなる。
   * 諦めた総額は、手数料率を見直す材料になる。
   */
  'written_off',
] as const;
export type ReceivableStatus = (typeof RECEIVABLE_STATUSES)[number];

export interface ReceivableRecord {
  readonly id: string;
  readonly creatorAccountId: string;
  readonly orderId: string;
  /** 残っている額（円）。⚠️ **正の数**で持つ。符号は使う側が付ける。 */
  readonly amount: number;
  readonly status: ReceivableStatus;
  readonly createdAt: Date;
  /** 決着した時刻。⚠️ `outstanding` のあいだは `null`。 */
  readonly settledAt: Date | null;
}

/**
 * 支払い後の返金を、どう扱うか決める。
 *
 * ⚠️ **支払い前なら、そもそも回収待ちにしない。** まだ渡していないので、
 * 確定前の売上を取り消すだけで済む。
 *
 * ⚠️ **「支払い済みか」は精算の状態で見る。** 返金の日付では見ない——
 * 締めと支払いの日はずれる。
 */
export type ClawbackPlan =
  | { readonly kind: 'cancel_pending'; readonly amount: number }
  | { readonly kind: 'offset_next'; readonly amount: number }
  | { readonly kind: 'receivable'; readonly amount: number };

export function planClawback(input: {
  /** 取り消す作家さま配分（円）。⚠️ 正の数。 */
  readonly creatorAmount: number;
  /** その注文が載った精算の状態。まだ載っていなければ `null`。 */
  readonly payoutStatus: 'draft' | 'confirmed' | 'paid' | null;
  /** 次回以降の精算で差し引ける見込み額。⚠️ 見込みであって約束ではない。 */
  readonly upcomingPayableAmount: number;
}): ClawbackPlan {
  /*
    ⚠️ **まだ精算に載っていない／下書きのまま＝確定前の売上。** 取り消せば
       済む。回収待ちにすると、渡していないお金を「返してもらう」ことになる。
  */
  if (input.payoutStatus === null || input.payoutStatus === 'draft') {
    return { kind: 'cancel_pending', amount: input.creatorAmount };
  }

  /*
    ⚠️ **確定済み（未払い）も、次回で差し引ける。** 確定は「払う」と決めた
       だけで、まだ渡していない。
  */
  if (input.upcomingPayableAmount >= input.creatorAmount) {
    return { kind: 'offset_next', amount: input.creatorAmount };
  }

  /*
    ⚠️ **差し引ききれない分だけを回収待ちにする。** 全額を回収待ちに
       すると、差し引ける分まで二重に取ることになる。
  */
  return {
    kind: 'receivable',
    amount: input.creatorAmount - Math.max(0, input.upcomingPayableAmount),
  };
}

/** 回収待ちの合計。⚠️ `outstanding` だけを足す。 */
export function outstandingTotal(rows: readonly ReceivableRecord[]): number {
  return rows
    .filter((row) => row.status === 'outstanding')
    .reduce((total, row) => total + row.amount, 0);
}
