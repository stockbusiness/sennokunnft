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

export {
  CHECKOUT_NOTICE_FIELD_KEYS,
  canDiscloseCheckoutTerms,
  checkoutNoticeFrom,
  type CheckoutLegalNotice,
  type CheckoutNoticeFieldKey,
} from './legal/checkout-notice';

export {
  CONSENT_REQUIRED_KINDS,
  evaluateConsentRequirement,
  requiresConsent,
  snapshotForOrder,
  type ConsentRequiredKind,
  type ConsentRequirement,
  type ConsentRequirementInput,
  type LegalConsentRecord,
  type OrderLegalSnapshot,
} from './legal/consent';

export type {
  LegalDocumentRepository,
  LegalConsentRepository,
  CreateLegalDraftCommand,
  SaveLegalDraftCommand,
  PublishLegalVersionCommand,
  RecordConsentCommand,
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

// 受取権の発行（P0-1）。決済が済んだ注文を受取権に変える。
export {
  ISSUANCE_BATCH_SIZE,
  ISSUANCE_MAX_ATTEMPTS,
  isIssuanceDue,
  planIssuance,
  reconcileSupply,
  scheduleIssuanceRetry,
  type IssuancePlan,
  type IssuanceRetry,
  type IssuanceTarget,
  type IssuanceUnit,
  type SupplyReconciliation,
} from './entitlement/issuance';

// 買った方が自分の受け取ったものを見る口（P0-3）。
export type {
  CollectibleListPage,
  CollectibleRepository,
  CollectibleView,
} from './ports/collectible';

export type {
  EntitlementIssuanceRepository,
  IssuanceCandidate,
  IssuanceOutcome,
} from './ports/issuance';

// Wallet への自動配送（P0-2）。登録済みの方にはこちらから届ける。
export {
  AUTO_DELIVERY_BATCH_SIZE,
  evaluateAutoDelivery,
  type AutoDeliveryDecision,
} from './entitlement/auto-delivery';

export {
  evaluateWalletClaim,
  type WalletClaimAttempt,
  type WalletClaimDecision,
  type WalletClaimableEntitlement,
} from './entitlement/wallet-claim';

// 全額返金にともなう取り消し（M3a）。受け取った事実は残し、権利だけを失わせる。
export {
  REVOCATION_EVENT_ID_PREFIX,
  REVOCATION_REVIEW_REASONS,
  decideRevocation,
  fallbackRevocationCorrelationId,
  revocableEntitlementStatuses,
  revocationEventId,
  type RevocationDecision,
  type RevocationReviewReason,
  type RevocationTarget,
} from './entitlement/revocation';

// 運用確認キュー。機械が決められなかったことを、拾い直せる形で残す。
export {
  OPERATIONS_REVIEW_MAX_PAGE_SIZE,
  OPERATIONS_REVIEW_PAGE_SIZE,
  OPERATIONS_REVIEW_REASON_CODES,
  OPERATIONS_REVIEW_STATUSES,
  OPERATIONS_REVIEW_SUBJECT_TYPES,
  type OpenOperationsReviewCommand,
  type OperationsReviewReasonCode,
  type OperationsReviewRecord,
  type OperationsReviewStatus,
  type OperationsReviewSubjectType,
} from './operations/review';

export type {
  OperationsReviewOpenCounts,
  OperationsReviewPage,
  OperationsReviewQuery,
  OperationsReviewRepository,
} from './ports/operations-review';

export type {
  MissingRevocation,
  RevocationReconcileRepository,
} from './ports/revocation-reconcile';

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
  WALLET_GRANTED_EVENT_VERSION,
  WALLET_REVOKED_EVENT_VERSION,
  BLOCKCHAIN_STATUS_NOT_MINTED,
  ENTITLEMENT_TYPE_DIGITAL_COLLECTIBLE,
  REVOCATION_REASON_CODES,
  isContentHash,
  isWalletCorrelationId,
  formatSerialNumber,
  isLongLivedImageUrl,
  buildGrantedEvent,
  buildRevokedEvent,
  type RevocationReasonCode,
  type WalletDeliveryEventType,
  type WalletEventMetadata,
  type WalletEventData,
  type WalletGrantedEvent,
  type WalletRevokedEvent,
  type WalletDeliveryEvent,
  type WalletEventEnvelopeInput,
  type WalletGrantedEventInput,
  type WalletRevokedEventInput,
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
  WalletDeliveryEnqueueOutcome,
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
  EmailHashPort,
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

export {
  EMPTY_ORDER_SEARCH,
  hasSearchCriteria,
  normalizeOrderSearch,
  type OrderNumberMatch,
  type OrderSearchCriteria,
  type OrderSearchInput,
} from './order/search';

export {
  ORDER_TIMELINE_KINDS,
  buildOrderTimeline,
  type OrderNoteEntry,
  type OrderTimelineEntry,
  type OrderTimelineInput,
  type OrderTimelineKind,
} from './order/timeline';

export {
  REFUND_REASONS,
  decideRefund,
  refundStatusAfter,
  type RefundDecision,
  type RefundEffects,
  type RefundEligibilityInput,
  type RefundReason,
} from './order/refund';

export {
  TRANSFER_FEE_BEARERS,
  REFUND_WINDOW_DAYS_MIN,
  REFUND_WINDOW_DAYS_MAX,
  PAYOUT_OFFSET_MONTHS_MIN,
  PAYOUT_OFFSET_MONTHS_MAX,
  MINIMUM_PAYOUT_AMOUNT_MAX,
  refundableUntil,
  validateSettlementSettings,
  type SettlementSettings,
  type TransferFeeBearer,
} from './settlement/settings';

export {
  DISPLAY_NAME_MAX_LENGTH,
  DISPLAY_NAME_MIN_LENGTH,
  displayNameKey,
  validateDisplayName,
  type ValidatedDisplayName,
} from './account/display-name';

export type { CreatorProfile, CreatorProfileRepository } from './ports/profile';

export type { SettlementSettingsRepository } from './ports/settlement';

export {
  PAYOUT_STATUSES,
  buildPayoutDraft,
  canConfirmPayout,
  transitionPayoutStatus,
  type PayoutCandidate,
  type PayoutClawback,
  type PayoutDraft,
  type PayoutDraftInput,
  type PayoutLineDraft,
  type PayoutStatus,
} from './settlement/payout';

export {
  isPeriodClosed,
  parsePayoutPeriod,
  payoutDueAt,
  payoutPeriodContaining,
  payoutPeriodOf,
  previousPayoutPeriod,
  type PayoutPeriod,
} from './settlement/period';

export type {
  PayoutLineView,
  NegativeCarryView,
  PayoutRepository,
  PayoutView,
  SavePayoutDraftCommand,
} from './ports/payout';

export {
  REFUND_RECORD_STATUSES,
  REFUND_INITIATORS,
  type RefundContext,
  type RefundInitiator,
  type RefundRecordStatus,
  type RefundRecordView,
  type RefundRepository,
  type RefundSettlement,
  type RevocationPayloadConflict,
  type RevocationPlan,
  type RevocationPlanInput,
  type RevocationPlanner,
  type RevocationReviewItem,
  type SettleRefundCommand,
  type StartRefundCommand,
} from './ports/refund';

export {
  ORDER_NOTE_MAX_LENGTH,
  validateOrderNote,
  type OrderNoteDraft,
  type ValidatedOrderNote,
} from './order/note';

export type { RandomPort } from './ports/index';

export type {
  OrderRepository,
  OrderNoteRepository,
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

export {
  CREDENTIAL_VERIFICATION_LIMIT,
  PAYMENT_CREDENTIAL_STATUSES,
  acceptingGeneration,
  activateGeneration,
  canAcceptPayments,
  retireGeneration,
  verificationOrder,
  type ActivateGenerationInput,
  type ActivatedGenerations,
  type PaymentCredentialGeneration,
  type PaymentCredentialStatus,
} from './payment/credential';

export type {
  PaymentGatewayPort,
  CreateCheckoutSessionInput,
  CheckoutSessionCreated,
  RefundExecuted,
  RefundPaymentInput,
} from './ports/payment';

export type {
  PaymentCredentialRepository,
  RegisterCredentialCommand,
  RecordCredentialCheckCommand,
  ActivateCredentialCommand,
  OpenedPaymentCredential,
} from './ports/payment-credential';

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

// --- 購入者への知らせ（P0-4） ---------------------------------------------
export {
  NOTIFICATION_EVENT_TYPES,
  NOTIFICATION_SUBJECT_TYPES,
  NOTIFICATION_VARIABLES,
  COMMON_NOTIFICATION_VARIABLES,
  allowedVariables,
  isNotificationEventType,
  subjectTypeOf,
} from './notification/events';
export type { NotificationEventType, NotificationSubjectType } from './notification/events';

export {
  NOTIFICATION_TEMPLATE_STATUSES,
  NOTIFICATION_SUBJECT_MAX,
  NOTIFICATION_BODY_MAX,
  referencedVariables,
  renderTemplate,
  validateTemplate,
} from './notification/template';
export type {
  NotificationTemplateDraft,
  NotificationTemplateStatus,
  RenderedNotification,
} from './notification/template';

export {
  NOTIFICATION_STATUSES,
  NOTIFICATION_MAX_ATTEMPTS,
  NOTIFICATION_BATCH_SIZE,
  canResendNotification,
  decideNotification,
  isRetryableMailOutcome,
  mailErrorCodeFor,
} from './notification/dispatch';
export type {
  MailAttemptOutcome,
  NotificationAttemptContext,
  NotificationDecision,
  NotificationStatus,
} from './notification/dispatch';

export { maskEmail } from './notification/recipient';
export type { RecipientResolution } from './notification/recipient';

// 法務文書の改定通知（`UD-127`）。
export {
  audienceFor,
  LEGAL_NOTICE_BATCH_SIZE,
  revisionValues,
  shouldNotifyRevision,
} from './notification/legal-revision';
export type { RevisionAudience } from './notification/legal-revision';

export type {
  MailSenderPort,
  NotificationEnqueueInput,
  NotificationEnqueueOutcome,
  NotificationFailureInput,
  NotificationHistoryPage,
  NotificationHistoryPort,
  NotificationHistoryQuery,
  NotificationHistoryRecord,
  NotificationOutboxPort,
  NotificationRecord,
  NotificationTemplateRecord,
  NotificationTemplateRepository,
  RecipientResolverPort,
} from './ports/notification';

// --- 運営ダッシュボード（P0-6） -------------------------------------------
export {
  DEFAULT_OPERATIONS_THRESHOLDS,
  JOB_LABELS,
  OPERATIONS_SEVERITIES,
  buildIndicators,
  overallSeverity,
} from './operations/dashboard';
export type {
  JobHeartbeat,
  OperationsCounts,
  OperationsIndicator,
  OperationsSeverity,
  OperationsThresholds,
} from './operations/dashboard';

export {
  CONSISTENCY_CHECK_KEYS,
  CONSISTENCY_SAMPLE_LIMIT,
  buildConsistencyFindings,
} from './operations/consistency';
export type {
  ConsistencyCheckKey,
  ConsistencyCounts,
  ConsistencyFinding,
} from './operations/consistency';

export type {
  EntitlementAdminDetailRecord,
  EntitlementAdminPort,
  EntitlementAdminRecord,
  OperationsMetricsPort,
} from './ports/operations';

// --- 本番販売ガード（P0-7） -----------------------------------------------
export {
  DEFAULT_PRODUCTION_READINESS_THRESHOLDS,
  PRODUCTION_READINESS_CHECKS,
  PRODUCTION_REQUIRED_JOB_KEYS,
  evaluateProductionReadiness,
} from './production/readiness';
export type {
  AcceptingCredentialFact,
  AttestationFact,
  ConnectionCheckFact,
  OwnerMfaFact,
  ProductionReadiness,
  ProductionReadinessCheck,
  ProductionReadinessCheckKey,
  ProductionReadinessFacts,
  ProductionReadinessThresholds,
} from './production/readiness';
export {
  ATTESTATION_KINDS,
  ATTESTATION_NOTE_MAX_LENGTH,
  decideAttestation,
  isAttestationKind,
} from './production/attestation';
export type {
  AttestationDecision,
  AttestationKind,
  AttestationRejection,
  RecordAttestationCommand,
} from './production/attestation';
export type {
  AttestationPort,
  AttestationRecord,
  ProductionReadinessPort,
} from './ports/production';
// --- 顧客サポート（P1-1） -------------------------------------------------
export { CUSTOMER_ATTENTION_KEYS, customerAttentions, netPaidAmount } from './customer/profile';
export type {
  CustomerAttention,
  CustomerAttentionKey,
  CustomerEntitlement,
  CustomerSummary,
} from './customer/profile';
export {
  DUPLICATE_SIGNAL_LABELS,
  DUPLICATE_SIGNALS,
  rankDuplicateCandidates,
} from './customer/duplicate';
export type { DuplicateCandidate, DuplicateSignal } from './customer/duplicate';
export {
  EMAIL_CHANGE_NOTE_MAX_LENGTH,
  EMAIL_CHANGE_STATUSES,
  IDENTITY_VERIFICATION_LABELS,
  IDENTITY_VERIFICATION_METHODS,
  completeEmailChange,
  isSettled,
  rejectEmailChange,
  verifyIdentity,
} from './customer/email-change';
export type {
  EmailChangeDecision,
  EmailChangeRejection,
  EmailChangeStatus,
  IdentityVerificationMethod,
} from './customer/email-change';
export type {
  AccountNotePort,
  AccountNoteRecord,
  CustomerDirectoryPort,
  CustomerOrderRow,
  CustomerRefundRow,
  EmailChangeRequestPort,
  EmailChangeRequestRecord,
} from './ports/customer';

// --- 作家さま運営（P1-2） -------------------------------------------------
export {
  EARNINGS_CSV_COLUMNS,
  buildEarningsCsv,
  estimateFromDraft,
  summarizeByArtwork,
  toEarningsCsvRows,
} from './creator/earnings';
export type { ArtworkSales, CreatorPeriodEarnings } from './creator/earnings';
export {
  CREATOR_BIO_MAX_LENGTH,
  CREATOR_LINK_LABEL_MAX_LENGTH,
  CREATOR_LINK_MAX_COUNT,
  CREATOR_SETUP_KEYS,
  CREATOR_SHOP_NAME_MAX_LENGTH,
  INVOICE_NUMBER_PATTERN,
  creatorSetupChecklist,
  validateCreatorProfile,
} from './creator/profile';
export type {
  CreatorLink,
  CreatorProfileDraft,
  CreatorSetupItem,
  CreatorSetupKey,
  ProfileDecision,
  ProfileRejection,
} from './creator/profile';
export type {
  CreatorEarningsPort,
  CreatorProfilePort,
  CreatorProfileRecord,
  PayoutAccountCipherPort,
  PayoutAccountPort,
  PayoutAccountRecord,
} from './ports/creator';

// お振込先（P1-3・`UD-124` 決定 2026-08-21）。
// ⚠️ 本人確認書類は取らない。口座情報の確認をもって足りるとする。
export {
  ACCOUNT_HOLDER_MAX,
  BANK_NAME_MAX,
  BRANCH_NAME_MAX,
  isPayoutAccountType,
  maskAccountNumber,
  PAYOUT_ACCOUNT_TYPES,
  payoutAccountTypeLabel,
  validatePayoutAccount,
} from './creator/payout-account';
export type {
  PayoutAccountInput,
  PayoutAccountType,
  ValidatedPayoutAccount,
} from './creator/payout-account';

export {
  SALES_REPORT_GRANULARITIES,
  SALES_REPORT_DEFAULT_DAYS,
  SALES_REPORT_DEFAULT_MONTHS,
  SALES_REPORT_MAX_ROWS,
  SALES_REPORT_CSV_COLUMNS,
  defaultSalesReportPeriod,
  salesReportPeriodKeys,
  buildSalesReport,
  salesReportTotals,
  toSalesReportCsvRows,
  buildSalesReportCsv,
  formatPeriodKey,
} from './reporting/sales';
export type {
  RefundAggregate,
  SalesAggregate,
  SalesReportGranularity,
  SalesReportPeriod,
  SalesReportRow,
} from './reporting/sales';
export type {
  CreatorDirectoryPort,
  CreatorDirectoryQuery,
  CreatorDirectorySummary,
  SalesReportPort,
} from './ports/reporting';

export {
  REFUND_REQUEST_STATUSES,
  REFUND_REQUEST_REASONS,
  REFUND_CATEGORIES,
  ENTITLEMENT_DISPOSITIONS,
  isTerminalRefundRequest,
  categoryOf,
  needsCreatorConfirmation,
  isExcludedByDefault,
  suggestDisposition,
  requiresDualApproval,
  canApprove,
  addBusinessDays,
  creatorInquiryExpired,
  checkRefundAmount,
  BUYER_SELECTABLE_REFUND_REASONS,
  isBuyerSelectableReason,
  clawbackBearerFor,
  clawbackBearerForRefundReason,
} from './refund/request';
export type {
  ApprovalDecision,
  ClawbackBearer,
  EntitlementDisposition,
  RefundAmountCheck,
  RefundCategory,
  RefundRequestReason,
  RefundRequestStatus,
} from './refund/request';
export { RECEIVABLE_STATUSES, planClawback, outstandingTotal } from './refund/receivable';
export type { ClawbackPlan, ReceivableRecord, ReceivableStatus } from './refund/receivable';
export type {
  CreatorInquiryPort,
  CreatorInquiryRecord,
  CreatorReceivablePort,
  RefundRequestPort,
  RefundPolicy,
  RefundPolicyPort,
  RefundRequestEventRecord,
  RefundRequestQuery,
  RefundRequestRecord,
} from './ports/refund-request';
