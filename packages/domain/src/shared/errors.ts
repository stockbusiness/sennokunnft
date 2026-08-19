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
  // --- 外部連携の設定と資格情報（管理画面・外部連携 指示書）---
  'INTEGRATION_SETTINGS_INVALID',
  'INTEGRATION_SETTINGS_CONFLICT',
  'INTEGRATION_ENDPOINT_INSECURE',
  'INTEGRATION_SECRET_MISSING',
  'INTEGRATION_SECRET_NOT_PENDING',
  /**
   * この連携は管理画面から変えられない。
   *
   * ⚠️ **「権限が無い」ではない。** オーナーでも変えられない。
   * 変えても誰も読まないため、受け付けること自体が嘘になる。
   */
  'INTEGRATION_NOT_MANAGED',
  // --- 注文（決済 Phase P0・P1）---
  /** 注文時の手数料率が受け付けられない値。 */
  'INVALID_FEE_RATE',
  // --- 決済（決済 Phase P2）---
  /**
   * 販売の設定が完了していない。
   *
   * ⚠️ **手数料率 0 は「無料」ではなく「未設定」**（`UD-109` の決定）。
   * 0 のまま売ると、あとから率を決めても過去の注文は 0% のままになる。
   * 売れないほうが取り返しがつく。
   */
  'SALES_SETUP_INCOMPLETE',
  /** その注文では決済を始められない（支払済み・期限切れなど）。 */
  'CHECKOUT_NOT_ALLOWED',
  /** 在庫のお取り置きの期限が過ぎている。 */
  'RESERVATION_EXPIRED',
  /** 決済事業者から届いた内容が、こちらの注文と食い違う。 */
  'PAYMENT_MISMATCH',
  /** 決済事業者とのやり取りに失敗した。 */
  'PAYMENT_PROVIDER_ERROR',
  /** Webhook の署名を検証できなかった。 */
  'WEBHOOK_SIGNATURE_INVALID',
  /**
   * その状態からその状態へは移せない。
   *
   * ⚠️ **どの状態からどこへ、を符号に含めない。** 含めると、
   * 内部の状態名がそのまま外へ出る。何が起きたかは符号で足りる。
   */
  'ORDER_TRANSITION_NOT_ALLOWED',
  /**
   * 同じ冪等キーで、前回と違う内容を送ってきた。
   *
   * ⚠️ **前回の注文を返さない。** 返すと、頼んだものと違う注文を
   * 「成功」として受け取ることになる。断って、気づかせる。
   */
  'ORDER_IDEMPOTENCY_MISMATCH',
  /** 1 注文 1 明細の制限を超えた（MVP 期間）。 */
  'ORDER_TOO_MANY_ITEMS',
  /**
   * 接続テストの成功が要る。
   *
   * ⚠️ **「保存できた」と「繋がった」を分けるための符号。**
   * 保存は自分の DB へ書けたというだけで、相手に届くかは別の話。
   */
  'INTEGRATION_CHECK_REQUIRED',
  'INTEGRATION_CHECK_STALE',
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
