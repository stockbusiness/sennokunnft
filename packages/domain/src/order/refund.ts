import { domainError, type DomainError } from '../shared/errors';
import { err, ok, type Result } from '../shared/result';
import type { EntitlementStatus, MintJobStatus } from '../state/machines';
import type { OrderPaymentStatus, RefundStatus } from './order-status';

/**
 * 返金してよいかの判定（`UD-104`。決定 2026-08-20）。
 *
 * **発行がどこまで進んだかで線を引く。** 発行してしまうと回収できない
 * （`UD-511`）ので、そこが唯一の自然な境界である。
 *
 * ⚠️ **この関数は設定を読まない。** 期限は注文へ焼き付けた
 * `refundableUntil` を引数で受け取る。ここで「いまの設定」を読むと、
 * 返金期間を延ばした瞬間に、精算済みの注文が「まだ返金できる」に化ける
 * （`docs/SETTLEMENT_AND_REFUND.md` §0）。
 *
 * ⚠️ **運営の不具合による返金を、期間で自動的に断らない。** 自社の不具合に
 * 「14 日を過ぎたので対応できません」と言うのは、消費者契約法上も、
 * 商売としても通らない。`reason` が `our_fault` のときは期限を見ない。
 *
 * ⚠️ **一部返金では受取権を動かさない**（2026-08-20 再確認）。数量や明細を
 * 指定して返金する経路が無く、どのシリアルを取り消すべきか機械には
 * 決められない。**推測で取り消さず、運用確認へ回す**（呼び出し元の責務）。
 */

/**
 * 返金の理由。
 *
 * ⚠️ **こちらで決めた符号だけ。** 決済事業者の文言をそのまま入れない。
 * 相手の都合で増減する語彙に、こちらの判定を預けることになる。
 */
export const REFUND_REASONS = [
  /** 購入者からの申し出（誤購入など）。⚠️ 期限の中でのみ受ける。 */
  'buyer_request',
  /**
   * 運営・システムの不具合。
   *
   * ⚠️ **期限の外でも受ける。** ここを期限で切ると、こちらの落ち度を
   * 期限で断ることになる。
   */
  'our_fault',
  /** 決済事業者の画面から返金された（あとから追随する）。 */
  'provider_initiated',
] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];

/** 判定に要る、注文の「いまの姿」。⚠️ すべて記録から取る。 */
export interface RefundEligibilityInput {
  readonly paymentStatus: OrderPaymentStatus;
  readonly refundStatus: RefundStatus;
  /** 注文へ焼き付けた期限。⚠️ 設定から計算し直さない。 */
  readonly refundableUntil: Date | null;
  /** 受取権の状態。まだ作られていなければ `null`。 */
  readonly entitlementStatus: EntitlementStatus | null;
  /** 発行ジョブの状態。まだ作られていなければ `null`。 */
  readonly mintStatus: MintJobStatus | null;
  readonly reason: RefundReason;
  /**
   * 受取済み（`claimed`）の受取権も取り消すか（`UD-104` 追補・2026-08-20 決定）。
   *
   * ⚠️ **段階導入のためのフラグ。設定を読まない。** 呼び出し元が渡す。
   * 偽なら従来どおり「受取済みは取り消さない」。
   */
  readonly revokeClaimedEntitlements: boolean;
  readonly now: Date;
}

/**
 * 返金したときに、受取権と発行ジョブをどうするか。
 *
 * ⚠️ **`processing` を `cancelled` にしない**（既存の不変条件 `INV-M4`）。
 * 外部へ送信済みの可能性があり、多重発行は回復できない。
 */
export interface RefundEffects {
  /** 受取権を取り消すか。⚠️ 受取り済みなら取り消さない。 */
  readonly revokeEntitlement: boolean;
  /** 発行ジョブを取り消すか。⚠️ `queued` のときだけ。 */
  readonly cancelMintJob: boolean;
  /**
   * 人の確認が要るか。
   *
   * ⚠️ **「できない」ではなく「機械が決めない」。** 発行処理中・発行済みは
   * 回収できないので、返すかどうかは事業の判断になる。画面から自動では
   * 返さないが、判断のうえで返すことはある。
   */
  readonly requiresManualReview: boolean;
}

export type RefundDecision =
  | { readonly kind: 'allowed'; readonly effects: RefundEffects }
  /** 機械では決めない。⚠️ 「拒否」ではない。 */
  | { readonly kind: 'needs_review'; readonly effects: RefundEffects; readonly note: string };

/**
 * 返金してよいかを決める。
 *
 * 断る場合は `Err`。⚠️ **符号は「直し方が分かる」ものにする。**
 */
export function decideRefund(input: RefundEligibilityInput): Result<RefundDecision, DomainError> {
  // 1. そもそも払われていない。
  if (input.paymentStatus !== 'succeeded') {
    return err(domainError('REFUND_NOT_ALLOWED', 'payment did not succeed'));
  }

  // 2. すでに全額返している。⚠️ 二度目を通すと二重返金になる。
  if (input.refundStatus === 'refunded') {
    return err(domainError('REFUND_ALREADY_DONE', 'already fully refunded'));
  }

  /*
    3. 期限。
    ⚠️ **運営の不具合と、事業者からの追随は期限を見ない。**
       前者は自社の落ち度、後者はもう返金されている事実の記録なので、
       こちらの期限で断る意味が無い。
  */
  const boundByWindow = input.reason === 'buyer_request';
  if (boundByWindow) {
    if (input.refundableUntil === null) {
      // 支払い済みなのに期限が無い＝記録が壊れている。黙って通さない。
      return err(domainError('REFUND_NOT_ALLOWED', 'refund window missing'));
    }
    if (input.now.getTime() > input.refundableUntil.getTime()) {
      return err(domainError('REFUND_WINDOW_CLOSED', 'refund window has closed'));
    }
  }

  // 4. 発行がどこまで進んだか。
  return ok(decideByProgress(input));
}

function decideByProgress(input: RefundEligibilityInput): RefundDecision {
  const { entitlementStatus, mintStatus } = input;

  /*
    発行処理中。⚠️ **外部へ送信済みの可能性がある。** 取り消すと
    多重発行になり、これは回復できない。返すかどうかは人が決める。
  */
  if (mintStatus === 'processing') {
    return {
      kind: 'needs_review',
      effects: { revokeEntitlement: false, cancelMintJob: false, requiresManualReview: true },
      note: 'minting in progress',
    };
  }

  // 発行済み。⚠️ 回収できない。作品はお手元に残る。
  if (mintStatus === 'succeeded') {
    return {
      kind: 'needs_review',
      effects: { revokeEntitlement: false, cancelMintJob: false, requiresManualReview: true },
      note: 'already minted',
    };
  }

  // 発行待ち。まだ外部へ送っていないので取り消せる。
  if (mintStatus === 'queued') {
    return {
      kind: 'allowed',
      // ⚠️ 受取権は `claimed` のまま。受け取った事実は消さない。
      effects: { revokeEntitlement: false, cancelMintJob: true, requiresManualReview: false },
    };
  }

  /*
    受取り済みだが発行ジョブがまだ無い。

    ⚠️ **「受け取った事実」と「いま使える権利」を分ける**（`UD-104` 追補）。
       全額返金が成立した以上、権利が使えるまま残るのは認められない。
       一方で受け取った事実は起きたことなので、`claimed_at` などの記録は
       消さない。取り消すのは権利の有効性だけである。
    ⚠️ 段階導入のため、実際に取り消すかは呼び出し元のフラグで決める。
  */
  if (entitlementStatus === 'claimed') {
    return {
      kind: 'allowed',
      effects: {
        revokeEntitlement: input.revokeClaimedEntitlements,
        cancelMintJob: false,
        requiresManualReview: false,
      },
    };
  }

  // まだ受け取っていない。何も渡していないので、受取権ごと取り消す。
  return {
    kind: 'allowed',
    effects: { revokeEntitlement: true, cancelMintJob: false, requiresManualReview: false },
  };
}

/**
 * 返金後の返金状態。
 *
 * ⚠️ **一部返金は自動処理しない**（既定の方針。記録のみ）。金額の整合を
 * 崩さないため、状態を動かすのは全額返金のときだけにする。
 */
export function refundStatusAfter(refundedAmount: number, orderTotal: number): RefundStatus {
  if (refundedAmount <= 0) {
    return 'none';
  }
  return refundedAmount >= orderTotal ? 'refunded' : 'partially_refunded';
}
