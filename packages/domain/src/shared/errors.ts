/**
 * ドメインエラーのコード一覧。
 *
 * HTTP ステータスへの対応付けは api 層が持つ（API_DESIGN.md §2.1）。
 * ドメイン層は HTTP を知らない。
 */
export const DOMAIN_ERROR_CODES = [
  'ARTWORK_NOT_AVAILABLE',
  'ARTWORK_NOT_PUBLISHED',
  'ARTWORK_SUPPLY_IMMUTABLE',
  'LISTING_NOT_ACTIVE',
  'LISTING_NOT_EDITABLE',
  'LISTING_PERIOD_INVALID',
  'INSUFFICIENT_SUPPLY',
  'INVALID_QUANTITY',
  'INVALID_MONEY',
  'CURRENCY_MISMATCH',
  'ORDER_NOT_PENDING',
  'INVALID_STATE_TRANSITION',
  'ENTITLEMENT_NOT_CLAIMABLE',
  'ENTITLEMENT_OWNER_MISMATCH',
  'CLAIM_TOKEN_INVALID',
  'MINT_ALREADY_EXISTS',
  'MINT_ATTEMPTS_EXHAUSTED',
  'IDEMPOTENCY_CONFLICT',
] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

export interface DomainError {
  readonly code: DomainErrorCode;
  /**
   * 開発者向けの補足。**利用者の入力値や秘匿値を含めてはならない。**
   * 利用者向け文言は表示層で `code` から解決する。
   */
  readonly detail?: string;
}

export function domainError(code: DomainErrorCode, detail?: string): DomainError {
  return detail === undefined ? { code } : { code, detail };
}
