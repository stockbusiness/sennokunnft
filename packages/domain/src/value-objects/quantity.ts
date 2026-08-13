import { domainError, type DomainError } from '../shared/errors';
import { err, ok, type Result } from '../shared/result';

/**
 * 1 注文あたりの数量上限。
 *
 * 上限を置くのは、巨大な数量で受取権が大量生成されるのを防ぐため
 * （1 数量 = 1 受取権レコードなので、数量はそのまま書き込み量になる）。
 * 実際の上限は listing ごとにさらに小さく設定できる。
 */
export const MAX_QUANTITY_PER_ORDER = 100;

export function validateQuantity(
  value: number,
  maxPerOrder: number = MAX_QUANTITY_PER_ORDER,
): Result<number, DomainError> {
  if (!Number.isSafeInteger(value)) {
    return err(domainError('INVALID_QUANTITY', 'quantity must be an integer'));
  }
  if (value < 1) {
    return err(domainError('INVALID_QUANTITY', 'quantity must be at least 1'));
  }
  const effectiveMax = Math.min(maxPerOrder, MAX_QUANTITY_PER_ORDER);
  if (value > effectiveMax) {
    return err(domainError('INVALID_QUANTITY', 'quantity exceeds the allowed maximum'));
  }
  return ok(value);
}
