import { domainError, type DomainError } from '../shared/errors';
import { err, ok, type Result } from '../shared/result';

/**
 * 作品の在庫（発行上限）カウンタ。
 *
 * 仮引当方式（DOMAIN_MODEL.md §5）:
 *   販売可能数 = maxSupply - reservedCount - issuedCount
 */
export interface SupplyCounters {
  readonly maxSupply: number;
  /** 決済待ちの注文が押さえている数。 */
  readonly reservedCount: number;
  /** 受取権として発行済みの数。 */
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
 * 仮引当を確定させる（決済確定）。
 *
 * 引当から発行済みへ**移す**だけなので、合計（reserved + issued）は変わらない。
 * ここで合計が増えるとオーバーセルになる。
 */
export function commitReservation(
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
