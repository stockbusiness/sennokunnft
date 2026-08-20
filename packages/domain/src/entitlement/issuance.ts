import { retryBackoffMinutes, RETRY_MAX_ATTEMPTS } from '../retry/backoff';
import { domainError, type DomainError } from '../shared/errors';
import { err, ok, type Result } from '../shared/result';
import {
  allocateSerialNumbers,
  finalizeConsumedReservation,
  type SupplyCounters,
} from '../supply/supply';

/**
 * 受取権の発行（P0-1）。
 *
 * **決済が済んだ注文を、受取権（Entitlement）に変える。** ここが開くまで、
 * Claim も Wallet 配送も返金時の失効も、作ってあるのに一度も動かない。
 *
 * ⚠️ **「あと何枚足りないか」を数えて作る。作った枚数を覚えない。**
 * 「何枚作ったか」を別の場所に記録して次回それを見る形にすると、記録と
 * 実物がずれた瞬間に、**足りないまま「済んだ」ことになる**か、**多く作る**
 * かのどちらかが起きる。数えるのは常に `entitlements` の実物である。
 *
 * ⚠️ **発行の待ち行列を別の表にしない。** 「決済が済んでいるのに受取権が
 * 足りない注文」は、注文と受取権から必ず導ける。行を足す方式にすると、
 * 「行の入れ忘れ」「行だけ残る」という**実物と食い違う壊れ方**が新しく
 * 増える。導出なら、取りこぼしても次の掃き出しで必ず拾い直せる。
 */

/** 発行の再試行の上限。超えたら自動でやり直さず、人手に回す。 */
export const ISSUANCE_MAX_ATTEMPTS = RETRY_MAX_ATTEMPTS;

/** 1 回の掃き出しで扱う注文の数。⚠️ 大きくすると 1 件の失敗が巻き添えを増やす。 */
export const ISSUANCE_BATCH_SIZE = 20;

/** 発行しようとしている注文明細の、いまの姿。 */
export interface IssuanceTarget {
  /** 注文明細が売った数。 */
  readonly quantity: number;
  /** すでに作ってある受取権の数。⚠️ 実物を数えた値であること。 */
  readonly alreadyIssued: number;
  /** 作品の在庫カウンタ。⚠️ 行ロックを取ったあとに読んだ値であること。 */
  readonly counters: SupplyCounters;
}

/** 1 枚ぶんの発行計画。 */
export interface IssuanceUnit {
  /**
   * 注文明細の中での通し番号（0 始まり）。
   *
   * ⚠️ **これが冪等の鍵。** `(order_line_id, unit_index)` に UNIQUE を
   * 張ってあるので、同じ Webhook が何度届いても 2 枚目は DB が弾く。
   * アプリ側の「もう作ったか」の判定に頼ると、同時に 2 本走った時に
   * 両方とも「まだ」と読んで両方作る。
   */
  readonly unitIndex: number;
  /** 作品の中での通し番号（1 始まり）。 */
  readonly serialNo: number;
}

export interface IssuancePlan {
  /** これから作る枚数。0 なら発行済み。 */
  readonly missing: number;
  readonly units: readonly IssuanceUnit[];
  /** 発行後の在庫カウンタ。⚠️ 受取権を作るのと同じトランザクションで書く。 */
  readonly counters: SupplyCounters;
}

/**
 * 不足している受取権を数え、番号を割り当てる。
 *
 * ⚠️ **この関数だけでは二重発行を防げない。** 読んでから書くまでに別の
 * トランザクションが割り込む。実際には作品行を `FOR UPDATE` でロックした
 * うえで使い、さらに `UNIQUE(order_line_id, unit_index)` と
 * `UNIQUE(artwork_id, serial_no)` を最終防壁にする。
 */
export function planIssuance(target: IssuanceTarget): Result<IssuancePlan, DomainError> {
  const { quantity, alreadyIssued, counters } = target;

  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    return err(domainError('INVALID_QUANTITY', 'quantity must be a positive integer'));
  }
  if (!Number.isSafeInteger(alreadyIssued) || alreadyIssued < 0) {
    return err(domainError('INVALID_QUANTITY', 'issued count must not be negative'));
  }
  if (alreadyIssued > quantity) {
    /*
      ⚠️ **黙って切り上げない。** 売った数より多く受取権がある状態は、
         どこかで二重に作ったということ。ここで「もう足りている」と
         読んで済ませると、原因が残ったまま見えなくなる。
    */
    return err(domainError('ENTITLEMENT_OVER_ISSUED', 'more entitlements than ordered'));
  }

  const missing = quantity - alreadyIssued;
  if (missing === 0) {
    // ⚠️ 失敗ではない。同じ知らせが 2 度届いただけ。
    return ok({ missing: 0, units: [], counters });
  }

  /*
    ⚠️ **番号を採るのが先、カウンタを動かすのが後。**
       `allocateSerialNumbers` は `issuedCount` を見て次の番号を決めるので、
       先にカウンタを動かすと番号が飛ぶ。
  */
  const serials = allocateSerialNumbers(counters, missing);

  const moved = finalizeConsumedReservation(counters, missing);
  if (!moved.ok) {
    /*
      ⚠️ ここに来るのは、押さえていた枠より多く発行しようとしたとき。
         決済が済んだ注文の枠は解放されない決まり（決定 A）なので、
         通常は起こらない。起きたら在庫の記録が壊れている。
    */
    return err(
      domainError('ENTITLEMENT_SUPPLY_MISMATCH', 'reserved supply does not cover issuance'),
    );
  }

  const units = serials.map((serialNo, offset) => ({
    unitIndex: alreadyIssued + offset,
    serialNo,
  }));

  return ok({ missing, units, counters: moved.value });
}

/** 発行に失敗した注文を、次にいつ試すか。 */
export interface IssuanceRetry {
  readonly attemptCount: number;
  /** `null` は「自動ではもう試さない」。人手に回す。 */
  readonly nextAttemptAt: Date | null;
  readonly exhausted: boolean;
}

/**
 * 失敗した発行の、次の試行を決める。
 *
 * ⚠️ **上限を超えたら止める。** 止めずに叩き続けると、直らない失敗が
 * ログを埋め、直る失敗が埋もれる。止めたことは画面に出して人へ渡す。
 */
export function scheduleIssuanceRetry(previousAttempts: number, now: Date): IssuanceRetry {
  const attemptCount = previousAttempts + 1;
  if (attemptCount >= ISSUANCE_MAX_ATTEMPTS) {
    return { attemptCount, nextAttemptAt: null, exhausted: true };
  }
  const waitMs = retryBackoffMinutes(attemptCount) * 60_000;
  return {
    attemptCount,
    nextAttemptAt: new Date(now.getTime() + waitMs),
    exhausted: false,
  };
}

/** いま掃き出しの対象にしてよいか。 */
export function isIssuanceDue(
  row: { readonly nextAttemptAt: Date | null; readonly attemptCount: number },
  now: Date,
): boolean {
  if (row.attemptCount >= ISSUANCE_MAX_ATTEMPTS) {
    // ⚠️ 上限を超えた行は拾わない。拾うと、直らない失敗が枠を食い続ける。
    return false;
  }
  // 一度も失敗していない行は `null`。すぐ試してよい。
  return row.nextAttemptAt === null || row.nextAttemptAt.getTime() <= now.getTime();
}

/**
 * 受取権の件数と `issuedCount` の食い違いを見つける（受入条件）。
 *
 * ⚠️ **直さない。数えて返すだけ。** どちらが正しいかは場合による——
 * 受取権が多ければ二重発行、カウンタが多ければ発行の取りこぼしで、
 * 直し方が逆になる。機械が勝手に寄せると、事故の跡が消える。
 */
export interface SupplyReconciliation {
  readonly artworkId: string;
  readonly issuedCount: number;
  readonly entitlementCount: number;
  readonly drift: number;
}

export function reconcileSupply(
  rows: readonly {
    readonly artworkId: string;
    readonly issuedCount: number;
    readonly entitlementCount: number;
  }[],
): SupplyReconciliation[] {
  return rows
    .map((row) => ({ ...row, drift: row.issuedCount - row.entitlementCount }))
    .filter((row) => row.drift !== 0);
}
