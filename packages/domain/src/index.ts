/**
 * `@sengoku/domain` — 業務規則の中核。
 *
 * 責務:
 *  - 値オブジェクト（金額・数量）と、その不変条件
 *  - 集約の状態遷移表と遷移判定
 *  - 在庫（発行上限）の計算
 *  - Claim の可否判定
 *  - 発行ジョブの再試行方針
 *  - 外部境界の **interface 定義（ポート）**
 *
 * 責務ではないもの:
 *  - HTTP・DB・フレームワーク・外部SDK への依存（**一切持たない**）
 *  - 実際の永続化や通信（ポートの実装は database / integrations が担う）
 *
 * この分離は「ビジネスロジックがフレームワーク層へ混在していないこと」という
 * 受入条件を、パッケージ境界として機械検査できるようにするためのもの。
 * `pnpm check:deps` が本パッケージの依存を検証する。
 */

export { ok, err, isOk, isErr, unwrap, type Result, type Ok, type Err } from './shared/result';
export {
  DOMAIN_ERROR_CODES,
  domainError,
  type DomainError,
  type DomainErrorCode,
} from './shared/errors';

export {
  createMoney,
  addMoney,
  subtractMoney,
  multiplyMoney,
  moneyEquals,
  type Money,
} from './value-objects/money';
export { validateQuantity, MAX_QUANTITY_PER_ORDER } from './value-objects/quantity';

export { createStateMachine, type StateMachine, type TransitionTable } from './state/transition';
export {
  ENTITLEMENT_STATUSES,
  MINT_JOB_STATUSES,
  ARTWORK_STATUSES,
  LISTING_STATUSES,
  entitlementStateMachine,
  mintJobStateMachine,
  artworkStateMachine,
  listingStateMachine,
  type EntitlementStatus,
  type MintJobStatus,
  type ArtworkStatus,
  type ListingStatus,
} from './state/machines';

export {
  ARTWORK_TITLE_MAX,
  ARTWORK_DESCRIPTION_MAX,
  ARTWORK_MAX_SUPPLY_LIMIT,
  createArtworkDraft,
  updateArtwork,
  publishArtwork,
  archiveArtwork,
  isPubliclyVisible,
  hasRemainingSupply,
  type Artwork,
  type CreateArtworkInput,
  type UpdateArtworkInput,
} from './catalog/artwork';

export { archiveArtworkAndEndListings, type ArchivedCatalogEntry } from './catalog/archive';
export { prepareArtworkDeletion, type DeletableCatalogEntry } from './catalog/deletion';

export {
  INVITABLE_ROLES,
  INVITATION_LIFETIME_DAYS,
  acceptInvitation,
  createInvitation,
  expireInvitation,
  isExpired as isInvitationExpired,
  isInvitableRole,
  isOpen as isInvitationOpen,
  normalizeEmail,
  revokeInvitation,
  type AcceptInvitationInput,
  type AcceptedInvitation,
  type CreateInvitationInput,
  type InvitableRole,
  type InvitationStatus,
  type StaffInvitation,
} from './staff/invitation';
export {
  applyInvitationToMember,
  changeMembership,
  type ChangeMembershipInput,
  type MemberRole,
  type MemberStatus,
  type StaffMember,
} from './staff/membership';
export { type StaffInvitationRepository, type StaffMemberRepository } from './ports/staff';

export {
  INTEGRATION_ENVIRONMENTS,
  INTEGRATION_SERVICES,
  integrationScope,
  isIntegrationEnvironment,
  isIntegrationService,
  type IntegrationEnvironment,
  type IntegrationService,
} from './integration/service';
export {
  type ConnectionCheckRecord,
  type IntegrationRepository,
  type SealedSecret,
  type SecretCipherPort,
  type SecretScope,
} from './ports/integration';
export {
  SECRET_PURPOSES,
  activateSecret,
  discardPendingSecret,
  isSecretPurpose,
  type ActivateSecretInput,
  type ActivatedSecrets,
  type IntegrationSecret,
  type SecretPurpose,
  type SecretStatus,
} from './integration/secret';
export {
  CHECK_FRESHNESS_MS,
  disableIntegration,
  enableIntegration,
  isCheckFresh,
  requiredSecretPurposes,
  storesSecrets,
  updateSettings,
  type EnableInput,
  type IntegrationSettings,
  type UpdateSettingsInput,
  type UpdatedSettings,
} from './integration/settings';

export {
  isSalesSetupComplete,
  updatePaymentSettings,
  validateSecretKeyForEnvironment,
  validateWebhookSecret,
  ORDER_ID_PLACEHOLDER,
  PAYMENT_API_ENDPOINT,
  PAYMENT_LIVE_KEY_PREFIX,
  PAYMENT_TEST_KEY_PREFIX,
  PAYMENT_WEBHOOK_SECRET_PREFIX,
  PLATFORM_FEE_RATE_BPS_MAX,
  type PaymentSettingsFields,
  type UpdatePaymentSettingsInput,
} from './integration/payment-settings';

// --- 法務文書（利用規約・プライバシーポリシー・特商法表記）------------------

export {
  LEGAL_BODY_MAX,
  LEGAL_DOCUMENT_KINDS,
  LEGAL_TITLE_MAX,
  LEGAL_VERSION_STATUSES,
  TOKUSHOHO_FIELD_KEYS,
  TOKUSHOHO_FIELD_MAX,
  effectiveVersion,
  isLegalDocumentKind,
  missingTokushohoFields,
  publish as publishLegalVersion,
  saveDraft as saveLegalDraft,
  type LegalDocumentKind,
  type LegalDocumentVersion,
  type LegalVersionStatus,
  type PublishInput as PublishLegalVersionInput,
  type SaveDraftInput as SaveLegalDraftInput,
  type TokushohoFields,
} from './legal/document';

export {
  renderLegalBody,
  versionLabel,
  type LegalBlock,
  type LegalVersionLabel,
} from './legal/render';

export type {
  LegalDocumentRepository,
  CreateLegalDraftCommand,
  SaveLegalDraftCommand,
  PublishLegalVersionCommand,
} from './ports/legal';

export {
  createListing,
  updateListing,
  activateListing,
  suspendListing,
  endListing,
  evaluatePurchasability,
  resolveDisplayState,
  unavailableReasonToError,
  type Listing,
  type CreateListingInput,
  type UpdateListingInput,
  type PurchasabilityInput,
  type UnavailableReason,
  type ListingDisplayState,
} from './catalog/listing';

export {
  evaluateClaim,
  mintIdempotencyPayload,
  type ClaimAttempt,
  type ClaimableEntitlement,
} from './entitlement/claim';

export {
  PUBLIC_CLAIM_STATUSES,
  WALLET_DELIVERY_STATUSES,
  toPublicClaimStatus,
  type PublicClaimStatus,
  type WalletDeliveryStatus,
} from './entitlement/claim-status';

export type {
  ClaimRepositoryPort,
  ClaimLookupResult,
  ClaimConfirmOutcome,
  ClaimArtworkSnapshot,
  ClaimDeliveryEnqueue,
} from './ports/claim';

export {
  evaluateReissue,
  type ReissuableEntitlement,
  type ReissueAttempt,
} from './entitlement/reissue';

export {
  evaluateWalletClaim,
  type WalletClaimAttempt,
  type WalletClaimDecision,
  type WalletClaimableEntitlement,
} from './entitlement/wallet-claim';

export {
  availableSupply,
  reserveSupply,
  releaseReservation,
  finalizeConsumedReservation,
  allocateSerialNumbers,
  type SupplyCounters,
} from './supply/supply';

export {
  RETRY_BACKOFF_MINUTES,
  RETRY_MAX_ATTEMPTS,
  retryBackoffMinutes,
  retryBackoffMs,
} from './retry/backoff';

export {
  WALLET_DELIVERY_EVENT_TYPES,
  SOURCE_SYSTEM_KEY,
  TARGET_SITE_KEY,
  WALLET_EVENT_VERSION,
  BLOCKCHAIN_STATUS_NOT_MINTED,
  ENTITLEMENT_TYPE_DIGITAL_COLLECTIBLE,
  isContentHash,
  formatSerialNumber,
  isLongLivedImageUrl,
  buildGrantedEvent,
  buildRevokedEvent,
  type WalletDeliveryEventType,
  type WalletEventMetadata,
  type WalletEventData,
  type WalletGrantedEvent,
  type WalletRevokedEvent,
  type WalletDeliveryEvent,
  type WalletEventEnvelopeInput,
  type WalletGrantedEventInput,
} from './wallet-delivery/event';

export {
  WALLET_DELIVERY_OUTBOX_STATUSES,
  WALLET_DELIVERY_MAX_ATTEMPTS,
  isRetryable,
  errorCodeFor,
  isSuccessStatus,
  decideDelivery,
  canManuallyResend,
  type WalletDeliveryOutboxStatus,
  type DeliveryAttemptOutcome,
  type DeliveryDecision,
  type DeliveryAttemptContext,
} from './wallet-delivery/dispatch';

export {
  STALE_PROCESSING_MS,
  sweepWalletDeliveries,
  type WalletDeliveryDependencies,
  type WalletDeliveryOutcome,
} from './wallet-delivery/dispatcher';

export type {
  WalletDeliveryRecord,
  WalletDeliveryEnqueueInput,
  WalletDeliveryFailureInput,
  WalletDeliveryOutboxPort,
  WalletDeliverySenderPort,
  WalletDeliveryAdminPort,
} from './ports/wallet-delivery';

export {
  WALLET_DELIVERY_PAGE_SIZE,
  WALLET_DELIVERY_MAX_PAGE_SIZE,
  WALLET_DELIVERY_MAX_BULK_RESEND,
  type WalletDeliveryAdminRecord,
  type WalletDeliveryAdminQuery,
  type WalletDeliveryAdminCursor,
  type WalletDeliveryAdminPage,
  type WalletDeliveryStatusCounts,
  type WalletDeliveryResendOutcome,
  type WalletDeliveryResendResult,
} from './wallet-delivery/admin';

export { encodeListCursor, decodeListCursor, type ListCursor } from './shared/cursor';

export {
  AUDIT_LOG_PAGE_SIZE,
  AUDIT_LOG_MAX_PAGE_SIZE,
  REDACTED_MARK,
  redactAuditSummary,
  type AuditLogEntryRecord,
  type AuditLogQuery,
  type AuditLogCursor,
  type AuditLogPage,
} from './audit/read';

export {
  BACKOFF_MINUTES,
  DEFAULT_MAX_ATTEMPTS,
  backoffMs,
  decideRetry,
  canCancelOnRefund,
  type MintJobSnapshot,
  type RetryDecision,
} from './mint/retry';

export {
  ALLOWED_IMAGE_TYPES,
  IMAGE_MAX_BYTES,
  IMAGE_MIN_BYTES,
  inspectImage,
  extensionFor,
  type AllowedImageType,
  type ImageInspection,
  type InspectImageInput,
} from './media/image';

export type { Page, PageQuery, ArtworkRepository, ListingRepository } from './ports/catalog';
export type {
  IdempotencyState,
  IdempotencyRecord,
  IdempotencyClaimInput,
  IdempotencyClaimResult,
  IdempotencyStore,
} from './ports/idempotency';

export type { NonceStorePort } from './ports/nonce';

export {
  consumeFixedWindow,
  type RateLimitWindow,
  type RateLimitInput,
  type RateLimitDecision,
  type RateLimitResult,
} from './rate-limit/fixed-window';

export type { RateLimiterPort } from './ports/rate-limit';

export {
  COMMON_USER_STATUSES,
  MATCHED_BY_VALUES,
  MAX_LINK_ATTEMPTS,
  isCommonUserId,
  isAcceptableMatch,
  isDueForAttempt,
  isUsableForClaim,
  backoffMinutes,
  unresolvedLink,
  applyResolution,
  applyFailure,
  type CommonUserStatus,
  type MatchedBy,
  type CommonUserLink,
  type CommonUserResolution,
  type CommonUserFailureKind,
} from './identity/common-user';

export type {
  CommonUserDirectoryPort,
  ResolveCommonUserInput,
  ResolveCommonUserResult,
} from './ports/common-user';

export type { CommonUserLinkRepository } from './ports/common-user-link';

export {
  advanceCommonUserLink,
  sweepCommonUserLinks,
  type LinkOutcome,
  type LinkDependencies,
} from './identity/linking';

export type {
  ClockPort,
  IdGeneratorPort,
  ClaimTokenPort,
  IssuedClaimToken,
  IdempotencyKeyPort,
  MintingPort,
  MintRequest,
  MintSubmission,
  MintStatus,
  MintState,
  MetadataStoragePort,
  StoredMetadata,
  EventPublisherPort,
  DomainEventRecord,
  StoragePort,
  StoredObject,
  PutObjectInput,
  AuditEntry,
  AuditLogPort,
  AuditLogReadPort,
} from './ports/index';

export {
  CONNECTION_CHECK_KINDS,
  isConnectionCheckKind,
  classifyProbe,
  canRunCheck,
  type ConnectionCheckKind,
  type ProbeOutcome,
  type CheckVerdict,
} from './integration/connection-check';

export { MANAGED_INTEGRATION_SERVICES, isManagedFromAdmin } from './integration/service';
export type { EnvIntegrationSummary } from './ports/integration';

// --- 注文（決済 Phase P0・P1）------------------------------------------------

export {
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  FULFILLMENT_STATUSES,
  REFUND_STATUSES,
  transitionOrderStatus,
  transitionPaymentStatus,
  transitionFulfillmentStatus,
  transitionRefundStatus,
  isOrderFinal,
  isOrderStatus,
  isOrderPaymentStatus,
  isFulfillmentStatus,
  isRefundStatus,
  type OrderStatus,
  type OrderPaymentStatus,
  type FulfillmentStatus,
  type RefundStatus,
} from './order/order-status';

export {
  BPS_DENOMINATOR,
  DEFAULT_PLATFORM_FEE_RATE_BPS,
  calculateOrderAmounts,
  type PricingInput,
  type OrderAmounts,
} from './order/pricing';

export { ORDER_NUMBER_PATTERN, generateOrderNumber, isOrderNumber } from './order/order-number';

export {
  DEFAULT_RESERVATION_MINUTES,
  createOrder,
  type CreateOrderInput,
  type OrderDraft,
  type OrderItemDraft,
} from './order/create-order';

export {
  RESERVATION_STATUSES,
  RELEASE_BATCH_SIZE,
  canRelease,
  isExpired,
  isReservationStatus,
  releaseReservationRecord,
  consumeReservationRecord,
  type Reservation,
  type ReservationStatus,
} from './order/reservation';

export type { RandomPort } from './ports/index';

export type {
  OrderRepository,
  CreateOrderCommand,
  CreateOrderOutcome,
  OrderItemCommand,
  OrderView,
  OrderItemView,
  ReservationView,
  ReleasedReservation,
  OrderListQuery,
  OrderListPage,
} from './ports/order';

export {
  decideCheckout,
  isSessionUsable,
  type CheckoutDecision,
  type CheckoutEligibilityInput,
  type CheckoutSessionSnapshot,
} from './payment/checkout';

export {
  PAYMENT_FACTS,
  verifyPaymentFact,
  isLivemodeConsistent,
  toSafeFailureCode,
  type PaymentFactKind,
  type ProviderPaymentFact,
  type OrderPaymentExpectation,
} from './payment/provider-event';

export type {
  PaymentGatewayPort,
  CreateCheckoutSessionInput,
  CheckoutSessionCreated,
} from './ports/payment';

export type {
  PaymentRepository,
  PaymentAttemptView,
  PaymentAttemptStatus,
  RecordCheckoutSessionCommand,
  ConfirmPaymentCommand,
  RecordWebhookCommand,
  WebhookClaim,
  WebhookReceiptRecord,
} from './ports/order';
