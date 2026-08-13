import { domainError, type DomainError } from '../shared/errors';
import { err, ok, type Result } from '../shared/result';

/**
 * 金額。
 *
 * 最小通貨単位の**整数**で保持する（NFR-01）。
 * JPY の最小通貨単位は 1 円なので、日本円運用では `amountMinor` = 円。
 *
 * 浮動小数点で金額を扱わない。0.1 + 0.2 !== 0.3 の世界で
 * 会計が合わなくなる事故を、型の段階で起こせないようにする。
 */
export interface Money {
  readonly amountMinor: number;
  readonly currency: string;
}

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export function createMoney(amountMinor: number, currency: string): Result<Money, DomainError> {
  if (!Number.isSafeInteger(amountMinor)) {
    return err(domainError('INVALID_MONEY', 'amountMinor must be a safe integer'));
  }
  if (amountMinor < 0) {
    return err(domainError('INVALID_MONEY', 'amountMinor must not be negative'));
  }
  if (!CURRENCY_PATTERN.test(currency)) {
    return err(domainError('INVALID_MONEY', 'currency must be a 3-letter ISO 4217 code'));
  }
  return ok({ amountMinor, currency });
}

export function addMoney(left: Money, right: Money): Result<Money, DomainError> {
  if (left.currency !== right.currency) {
    return err(domainError('CURRENCY_MISMATCH', 'cannot add different currencies'));
  }
  return createMoney(left.amountMinor + right.amountMinor, left.currency);
}

export function subtractMoney(left: Money, right: Money): Result<Money, DomainError> {
  if (left.currency !== right.currency) {
    return err(domainError('CURRENCY_MISMATCH', 'cannot subtract different currencies'));
  }
  return createMoney(left.amountMinor - right.amountMinor, left.currency);
}

/**
 * 単価 × 数量。
 *
 * 乗算は整数同士なので誤差は出ないが、桁溢れは起こりうる。
 * `createMoney` の safe integer 検証で弾く。
 */
export function multiplyMoney(money: Money, quantity: number): Result<Money, DomainError> {
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    return err(domainError('INVALID_QUANTITY', 'quantity must be a non-negative integer'));
  }
  return createMoney(money.amountMinor * quantity, money.currency);
}

export function moneyEquals(left: Money, right: Money): boolean {
  return left.currency === right.currency && left.amountMinor === right.amountMinor;
}
