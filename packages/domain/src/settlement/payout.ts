import { domainError, type DomainError } from '../shared/errors';
import { err, ok, type Result } from '../shared/result';
import type { TransferFeeBearer } from './settings';
import type { PayoutPeriod } from './period';

/**
 * 精算の組み立て（`UD-119`。決定 2026-08-20）。
 *
 * ⚠️ **ここは金額を「決める」場所であって、「直す」場所ではない。**
 * 人が金額を書き換える口を作らない（`SETTLEMENT_AND_REFUND.md` §4）。
 * 訂正は**次の期間での調整**として行う。直接書き換えを許すと、
 * 明細と振込額が食い違ったときに、どちらが正しいのか誰にも分からなくなる。
 *
 * ⚠️ **設定は「そのとき何を使ったか」として焼き付ける。** 最低支払額も
 * 振込手数料の負担も、あとから変えて過去の精算が動いてはいけない
 * （`SETTLEMENT_AND_REFUND.md` §0 の三層のうち②）。
 */

/**
 * 精算の状態。
 *
 * ⚠️ **`confirmed` 以降は行を書き換えない。** 締めたあとに金額が動くと、
 * 作家さまへ渡した明細と食い違う。
 */
export const PAYOUT_STATUSES = ['draft', 'confirmed', 'paid'] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

const PAYOUT_TRANSITIONS: Readonly<Record<PayoutStatus, readonly PayoutStatus[]>> = {
  // ⚠️ 下書きは作り直せる。締める前なら、何度でも集計し直してよい。
  draft: ['draft', 'confirmed'],
  /*
    ⚠️ **`confirmed` から `draft` へ戻さない。** 戻せると、明細を渡した
       あとに金額を変える道ができる。訂正は次の期間での調整で行う。
  */
  confirmed: ['paid'],
  // ⚠️ 支払い済みは終着。取り消しは次の期間での調整で表す。
  paid: [],
};

export function transitionPayoutStatus(
  from: PayoutStatus,
  to: PayoutStatus,
): Result<PayoutStatus, DomainError> {
  return PAYOUT_TRANSITIONS[from].includes(to)
    ? ok(to)
    : err(domainError('PAYOUT_NOT_EDITABLE', `cannot move payout from ${from} to ${to}`));
}

/**
 * 精算に載せる注文 1 件ぶん。
 *
 * ⚠️ **すべて注文からの写し。** マスタを引き直さない。作品名を引き直すと、
 * 改名したときに過去の明細の作品名まで変わる。
 */
export interface PayoutCandidate {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly creatorAccountId: string;
  /** ⚠️ 注文時点の作品名。マスタを引き直さない。 */
  readonly artworkTitleSnapshot: string;
  readonly paidAt: Date;
  /** 販売額（税込）。 */
  readonly grossAmount: number;
  readonly feeRateBps: number;
  readonly feeAmount: number;
  /** 作家さまの取り分。⚠️ 注文時点で確定している。 */
  readonly netAmount: number;
  /**
   * 返金を受け付ける期限。
   *
   * ⚠️ **これが閉じるまで確定しない。** 閉じる前に支払うと、返金のたびに
   * 作家さまから返してもらう話になる（`SETTLEMENT_AND_REFUND.md` §2-3）。
   * ⚠️ `null` は「期限が付いていない古い注文」。閉じたとみなさない。
   */
  readonly refundableUntil: Date | null;
}

/**
 * すでに確定した精算に載っていた注文が、あとから返金されたぶん。
 *
 * ⚠️ **次回以降の精算から差し引く**（`SETTLEMENT_AND_REFUND.md` §2-3）。
 * 差し引ききれない分はマイナスの繰越として持ち越す。
 */
export interface PayoutClawback {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly artworkTitleSnapshot: string;
  /** 差し引く額。⚠️ 正の数で渡す。符号はここで付ける。 */
  readonly netAmount: number;
}

/** 精算を組み立てるための入力。⚠️ 設定はこの時点の値を渡す。 */
export interface PayoutDraftInput {
  readonly period: PayoutPeriod;
  readonly creatorAccountId: string;
  readonly candidates: readonly PayoutCandidate[];
  readonly clawbacks: readonly PayoutClawback[];
  /** 前の期間からの繰越。⚠️ マイナスもありうる。 */
  readonly carriedInAmount: number;
  /** ⚠️ **その時点の**最低支払額。焼き付ける。 */
  readonly minimumPayoutAmount: number;
  /** ⚠️ **その時点の**振込手数料の負担。焼き付ける。 */
  readonly transferFeeBearer: TransferFeeBearer;
  /**
   * いまの時刻。返金の窓が閉じたかの判定に使う。
   *
   * ⚠️ **`Date.now()` を関数の中で読まない。** 読むと、同じ入力で
   * 違う結果が出る関数になり、試験で境界を確かめられなくなる。
   */
  readonly now: Date;
}

/** 明細 1 行。⚠️ 差し戻しは `netAmount` がマイナスになる。 */
export interface PayoutLineDraft {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly artworkTitleSnapshot: string;
  readonly grossAmount: number;
  readonly feeRateBps: number;
  readonly feeAmount: number;
  readonly netAmount: number;
  /** ⚠️ 差し戻し（過去の精算に載った注文の返金）かどうか。 */
  readonly isClawback: boolean;
}

export interface PayoutDraft {
  readonly period: PayoutPeriod;
  readonly creatorAccountId: string;
  readonly lines: readonly PayoutLineDraft[];
  readonly grossAmount: number;
  readonly feeAmount: number;
  /** 差し戻した額の合計。⚠️ 正の数で持つ。 */
  readonly refundedAmount: number;
  readonly carriedInAmount: number;
  /** 今回のお支払額。⚠️ 最低支払額に満たなければ 0。 */
  readonly netAmount: number;
  /** 翌月への繰越。⚠️ マイナスもありうる。 */
  readonly carriedOutAmount: number;
  readonly minimumPayoutAmount: number;
  readonly transferFeeBearer: TransferFeeBearer;
  /**
   * 返金の窓がまだ開いている注文の数。
   *
   * ⚠️ **0 でなければ確定できない。** 下書きとしては作ってよい——運営が
   * 「今月はいくらになりそうか」を見られる方が親切なので。確定だけを止める。
   */
  readonly openRefundWindows: number;
}

/**
 * 精算の下書きを組み立てる。
 *
 * ⚠️ **返金済みの注文は呼び出し側で除いておく。** ここは渡されたものを
 * 合計するだけにしてある。「除く条件」を 2 か所に置くと必ずずれる。
 *
 * ⚠️ **繰越は「払わなかった額」であって「利益」ではない。** 最低支払額に
 * 満たないときは全額を翌月へ送る。少額を刻んで振込手数料に消えるのを
 * 避けるための決まりで、こちらが預かる話ではない。
 */
export function buildPayoutDraft(input: PayoutDraftInput): PayoutDraft {
  const lines: PayoutLineDraft[] = input.candidates.map((candidate) => ({
    orderId: candidate.orderId,
    orderNumber: candidate.orderNumber,
    artworkTitleSnapshot: candidate.artworkTitleSnapshot,
    grossAmount: candidate.grossAmount,
    feeRateBps: candidate.feeRateBps,
    feeAmount: candidate.feeAmount,
    netAmount: candidate.netAmount,
    isClawback: false,
  }));

  /*
    ⚠️ **差し戻しも明細に載せる。** 合計だけ減らすと、作家さまが
       「なぜ今月は少ないのか」を明細から読み取れない。
    ⚠️ 符号はここで付ける。呼び出し側に正負を判断させない。
  */
  for (const clawback of input.clawbacks) {
    lines.push({
      orderId: clawback.orderId,
      orderNumber: clawback.orderNumber,
      artworkTitleSnapshot: clawback.artworkTitleSnapshot,
      grossAmount: 0,
      feeRateBps: 0,
      feeAmount: 0,
      netAmount: -clawback.netAmount,
      isClawback: true,
    });
  }

  const grossAmount = sum(input.candidates.map((row) => row.grossAmount));
  const feeAmount = sum(input.candidates.map((row) => row.feeAmount));
  const earned = sum(input.candidates.map((row) => row.netAmount));
  const refundedAmount = sum(input.clawbacks.map((row) => row.netAmount));

  /*
    今回の残高。⚠️ **繰越を足してから最低支払額と比べる。** 先に比べると、
    毎月 900 円の作家さまが永久に受け取れない。
  */
  const balance = input.carriedInAmount + earned - refundedAmount;

  /*
    ⚠️ **マイナスは払わない。** 差し引ききれない分は翌月へ持ち越す。
       ここで 0 に丸めると、差し戻しがそのまま消える。
  */
  const payable = balance >= input.minimumPayoutAmount && balance > 0;
  const netAmount = payable ? balance : 0;
  const carriedOutAmount = balance - netAmount;

  return {
    period: input.period,
    creatorAccountId: input.creatorAccountId,
    lines,
    grossAmount,
    feeAmount,
    refundedAmount,
    carriedInAmount: input.carriedInAmount,
    netAmount,
    carriedOutAmount,
    minimumPayoutAmount: input.minimumPayoutAmount,
    transferFeeBearer: input.transferFeeBearer,
    openRefundWindows: input.candidates.filter((row) => !isWindowClosed(row, input.now)).length,
  };
}

/**
 * 確定してよいか。
 *
 * ⚠️ **返金の窓が閉じていない注文が 1 件でもあれば断る**
 * （`SETTLEMENT_AND_REFUND.md` §2-3）。閉じる前に確定すると、返金のたびに
 * 作家さまから返してもらう話になる。いちばん揉める作業で、少額なら
 * 回収を諦めることになり、諦めた分は運営の損になる。
 *
 * ⚠️ **0 円の精算も確定してよい。** 繰越だけの月は普通に起きる。
 * 「払う額が無い」ことと「まだ締められない」ことは別。
 *
 * ⚠️ **数え直した件数を渡す。** 下書きを作った時点の件数ではない。
 * 下書きを作ってから確定するまでのあいだに窓は閉じるので、作った時点で
 * 止めると、いつまでも確定できない精算ができる。
 */
export function canConfirmPayout(subject: {
  readonly openRefundWindows: number;
}): Result<true, DomainError> {
  if (subject.openRefundWindows > 0) {
    return err(domainError('PAYOUT_WINDOW_OPEN', 'some orders can still be refunded'));
  }
  return ok(true);
}

/**
 * 返金の窓が閉じているか。
 *
 * ⚠️ **期限が付いていない注文を「閉じた」とみなさない。** 期限の列より前に
 * 支払われた注文が該当する。付いていないものを閉じた扱いにすると、
 * まだ返金されうる注文を確定してしまう。**分からないものは、
 * 分からないまま止める。**
 */
function isWindowClosed(candidate: PayoutCandidate, now: Date): boolean {
  return candidate.refundableUntil !== null && candidate.refundableUntil.getTime() <= now.getTime();
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
