import { domainError, type DomainError } from '../shared/errors';
import { err, ok, type Result } from '../shared/result';

/**
 * 作品の在庫（発行上限）カウンタ。
 *
 * 仮引当方式（DOMAIN_MODEL.md §5）:
 *   販売可能数 = maxSupply - reservedCount - issuedCount
 *
 * ⚠️ **2 つのカウンタの意味を混ぜない（決済 Phase P2 で確定）。**
 * `issuedCount` は「受取権を**実際に発行した**数」であって、
 * 「売れた数」ではない。決済が済んだだけの枠は `reservedCount` に残す。
 */
export interface SupplyCounters {
  readonly maxSupply: number;
  /**
   * まだ受取権になっていない注文が押さえている数。
   *
   * ⚠️ **「決済待ち」だけではない。** 決済が済んで受取権の発行を待って
   * いる枠も、ここに含まれる（決済 Phase P2 の決定 A）。決済成功で
   * ここを減らすと、受取権を作る前のわずかな間だけ販売枠が復活し、
   * その隙に売れた注文の発行が上限で弾かれる。
   */
  readonly reservedCount: number;
  /**
   * 受取権として発行済みの数。
   *
   * ⚠️ **`entitlements` の行数と一致させる。** ここだけ先に増やすと、
   * シリアル番号の採番（`allocateSerialNumbers`）がずれる。
   * 増やしてよいのは受取権を作るのと同じトランザクションの中だけ。
   */
  readonly issuedCount: number;
}

export function availableSupply(counters: SupplyCounters): number {
  return counters.maxSupply - counters.reservedCount - counters.issuedCount;
}

/**
 * 仮引当を行った後のカウンタを返す。
 *
 * **この関数だけではオーバーセルを防げない。**
 * 読み取りと書き込みの間に別トランザクションが割り込むためである。
 * 実際には作品行を `FOR UPDATE` でロックしたうえで本関数を使い、
 * さらに DB の CHECK 制約（reserved + issued <= max）を最終防壁とする
 * （DATABASE_DESIGN.md §3.2）。
 */
export function reserveSupply(
  counters: SupplyCounters,
  quantity: number,
): Result<SupplyCounters, DomainError> {
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    return err(domainError('INVALID_QUANTITY', 'quantity must be a positive integer'));
  }
  if (availableSupply(counters) < quantity) {
    return err(domainError('INSUFFICIENT_SUPPLY', 'not enough supply available'));
  }
  return ok({ ...counters, reservedCount: counters.reservedCount + quantity });
}

/** 仮引当を解放する（決済失敗・期限切れ）。 */
export function releaseReservation(
  counters: SupplyCounters,
  quantity: number,
): Result<SupplyCounters, DomainError> {
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    return err(domainError('INVALID_QUANTITY', 'quantity must be a positive integer'));
  }
  if (counters.reservedCount < quantity) {
    return err(domainError('INSUFFICIENT_SUPPLY', 'cannot release more than reserved'));
  }
  return ok({ ...counters, reservedCount: counters.reservedCount - quantity });
}

/**
 * 押さえていた枠を、受取権の発行済みへ**移す**。
 *
 * 引当から発行済みへ移すだけなので、合計（reserved + issued）は変わらない。
 * ここで合計が増えるとオーバーセルになる。
 *
 * ⚠️ **決済が成功しただけでは呼ばない**（決済 Phase P2 の決定 A）。
 * 呼んでよいのは、**受取権を作るのと同じトランザクションの中**だけ。
 * 名前を `commitReservation` から変えたのは、「決済の確定」と読めて
 * 決済成功の経路から呼ばれかけたため。この関数がするのは
 * 「発行済みへ移すこと」であって、決済の確定ではない。
 *
 * ⚠️ **シリアル番号の採番はこの関数の**前**に行う。**
 * `allocateSerialNumbers` は `issuedCount` を見て番号を決めるので、
 * 先に増やすと 1 番から始まらない。
 */
export function finalizeConsumedReservation(
  counters: SupplyCounters,
  quantity: number,
): Result<SupplyCounters, DomainError> {
  const released = releaseReservation(counters, quantity);
  if (!released.ok) {
    return released;
  }
  return ok({
    ...released.value,
    issuedCount: released.value.issuedCount + quantity,
  });
}

/**
 * 発行する受取権のシリアル番号を採番する。
 *
 * 受取権は 1 枚単位なので、数量 N に対して N 個の番号を返す。
 * 一意性は DB の `UNIQUE(artwork_id, serial_no)` が最終的に担保する。
 */
export function allocateSerialNumbers(counters: SupplyCounters, quantity: number): number[] {
  const start = counters.issuedCount + 1;
  return Array.from({ length: quantity }, (_, index) => start + index);
}
