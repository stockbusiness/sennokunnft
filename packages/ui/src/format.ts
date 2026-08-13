/**
 * 表示用の整形。
 *
 * ⚠️ **整形は表示層の責務であり、金額の計算はここで行わない。**
 * 内部表現は常に最小通貨単位の整数のままにしておく（NFR-01）。
 */

/** 通貨ごとの小数桁数。ここに無い通貨は 2 桁として扱う。 */
const CURRENCY_FRACTION_DIGITS: Readonly<Record<string, number>> = {
  JPY: 0,
  KRW: 0,
  USD: 2,
  EUR: 2,
};

export interface MoneyView {
  readonly amount: number;
  readonly currency: string;
}

/**
 * 金額を表示用の文字列にする。
 *
 * @param locale 既定は日本語表記
 */
export function formatMoney(money: MoneyView, locale = 'ja-JP'): string {
  const fractionDigits = CURRENCY_FRACTION_DIGITS[money.currency] ?? 2;
  const value = money.amount / 10 ** fractionDigits;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: money.currency,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value);
}

/**
 * 内部用語を利用者向けの表記に変換する。
 *
 * 購入者は暗号資産やウォレットの知識を持たない前提のため、
 * UI に Web3 用語を出さない（PRODUCT_REQUIREMENTS.md §2.2）。
 * ⚠️ 正式な用語集は未承認（UD-103）。ここは暫定。
 */
export const UI_TERMS: Readonly<Record<string, string>> = {
  nft: 'デジタル作品',
  mint: '発行',
  claim: '受取り',
  wallet: '受取先',
  entitlement: '受取り権利',
};
