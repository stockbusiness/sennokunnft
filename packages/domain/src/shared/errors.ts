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
  'ARTWORK_NOT_DELETABLE',
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
  // Claim API（API_DESIGN.md §3-2）で確定した符号。
  // ⚠️ 相手システムと合わせた契約なので、**綴りを変えない**。
  'CLAIM_EXPIRED',
  'CLAIM_REVOKED',
  'CLAIM_PROCESSING',
  'MINT_ALREADY_EXISTS',
  'MINT_ATTEMPTS_EXHAUSTED',
  'IDEMPOTENCY_CONFLICT',
  // --- 運営スタッフの招待と権限（`UD-803` 決定 2026-08-18）---
  'STAFF_INVITE_INVALID',
  /**
   * その招待はいま受け取れない。
   *
   * ⚠️ **「宛先が違う」と「招待が無い」を分けない。** 分けると、
   * どの宛先に招待が出ているかを総当たりで探れる。
   */
  'STAFF_INVITE_NOT_OPEN',
  'STAFF_INVITE_EXPIRED',
  'STAFF_INVITE_DUPLICATE',
  'STAFF_ALREADY_MEMBER',
  'STAFF_NOT_MEMBER',
  'STAFF_SELF_CHANGE',
  'STAFF_LAST_OWNER',
  'STAFF_OWNER_MUST_BE_OPERATOR',
  'IMAGE_INVALID',
  'IMAGE_TOO_LARGE',
  'IMAGE_UNSUPPORTED_TYPE',
  'COMMON_USER_ID_INVALID',
  'COMMON_USER_PENDING',
  'COMMON_USER_MISMATCH',
  /**
   * Wallet へ送るイベントを組み立てられなかった。
   *
   * ⚠️ これは**外へ返す符号ではない**。相手へ送る前に落ちているので、
   * 利用者への応答ではなく運用ログとアラートへ出す。
   */
  'WALLET_EVENT_INVALID',
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
