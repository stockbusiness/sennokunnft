/**
 * `@sengoku/contracts` — アプリケーション間の契約。
 *
 * ⚠️ **「スマートコントラクト」ではない。**
 * ここに置くのは API の DTO とドメインイベントのスキーマ、つまり
 * web ⇄ api、api ⇄ 外部システムの間で守るべき取り決めである。
 * スマートコントラクトのソースは MVP スコープ外で、
 * 将来必要になれば `packages/onchain` を新設する（UD-301）。
 *
 * 責務:
 *  - リクエスト / レスポンスの形と、その実行時検証スキーマ
 *  - イベント封筒とデータ部のスキーマ、バージョン
 *
 * 責務ではないもの:
 *  - 業務判断（`@sengoku/domain`）
 *  - 通信の実行（`apps/api` / `apps/worker`）
 *
 * スキーマを単一の正とし、TypeScript 型と実行時検証の両方をここから導出する。
 * 手書きの型定義と実装は必ず乖離するため。
 */
export {
  apiErrorSchema,
  TRANSPORT_ERROR_CODES,
  type ApiError,
  type TransportErrorCode,
} from './errors';

export {
  EVENT_NAMES,
  EVENT_DATA_SCHEMAS,
  eventEnvelopeSchema,
  orderPaidDataSchema,
  entitlementIssuedDataSchema,
  entitlementClaimedDataSchema,
  mintSucceededDataSchema,
  mintFailedDataSchema,
  type EventName,
  type EventEnvelope,
  type OrderPaidData,
  type EntitlementIssuedData,
  type EntitlementClaimedData,
  type MintSucceededData,
  type MintFailedData,
} from './events';

export {
  READINESS_STATUSES,
  livenessResponseSchema,
  readinessResponseSchema,
  readinessCheckSchema,
  type LivenessResponse,
  type ReadinessResponse,
  type ReadinessCheck,
} from './health';

export {
  ARTWORK_STATUS_VALUES,
  LISTING_STATUS_VALUES,
  LISTING_DISPLAY_STATES,
  artworkSummarySchema,
  artworkDetailSchema,
  artworkListResponseSchema,
  artworkListQuerySchema,
  createArtworkRequestSchema,
  updateArtworkRequestSchema,
  adminArtworkSchema,
  adminArtworkListResponseSchema,
  createListingRequestSchema,
  updateListingRequestSchema,
  adminListingSchema,
  adminListingListResponseSchema,
  publicListingSchema,
  publicListingListResponseSchema,
  uploadImageResponseSchema,
  type MoneyView,
  type ArtworkSummary,
  type ArtworkDetail,
  type ArtworkListResponse,
  type ArtworkListQuery,
  type CreateArtworkRequest,
  type UpdateArtworkRequest,
  type AdminArtwork,
  type AdminArtworkListResponse,
  type CreatorArtwork,
  type CreatorListing,
  type CreateListingRequest,
  type UpdateListingRequest,
  type AdminListing,
  type AdminListingListResponse,
  type PublicListing,
  type PublicListingListResponse,
  type UploadImageResponse,
} from './catalog';

export {
  INVITABLE_ROLE_VALUES,
  INVITATION_STATUS_VALUES,
  MEMBER_ROLE_VALUES,
  MEMBER_STATUS_VALUES,
  acceptInvitationResponseSchema,
  createStaffInvitationRequestSchema,
  staffInvitationSchema,
  staffListResponseSchema,
  staffMemberSchema,
  updateStaffMemberRequestSchema,
  type AcceptInvitationResponse,
  type CreateStaffInvitationRequest,
  type StaffInvitationView,
  type StaffListResponse,
  type StaffMemberView,
  type UpdateStaffMemberRequest,
} from './staff';

export {
  INTEGRATION_ENVIRONMENT_VALUES,
  INTEGRATION_SERVICE_VALUES,
  SECRET_PURPOSE_VALUES,
  connectionCheckSchema,
  environmentSummarySchema,
  integrationListResponseSchema,
  integrationSecretSchema,
  integrationStatusSchema,
  paymentSettingsSchema,
  registerSecretRequestSchema,
  updateIntegrationRequestSchema,
  type ConnectionCheckView,
  type EnvironmentSummaryView,
  type IntegrationListResponse,
  type IntegrationSecretView,
  type IntegrationStatusView,
  type PaymentSettingsView,
  type RegisterSecretRequest,
  type UpdateIntegrationRequest,
} from './integration';

export {
  WALLET_DELIVERY_STATUS_VALUES,
  walletDeliverySchema,
  walletDeliveryListResponseSchema,
  resendWalletDeliveriesRequestSchema,
  resendWalletDeliveriesResponseSchema,
  walletDeliveryResendResultSchema,
  type WalletDeliveryView,
  type WalletDeliveryListResponse,
  type ResendWalletDeliveriesRequest,
  type ResendWalletDeliveriesResponse,
} from './wallet-delivery';

export {
  auditLogEntrySchema,
  auditLogListResponseSchema,
  type AuditLogEntryView,
  type AuditLogListResponse,
} from './audit';

export {
  ORDER_STATUS_VALUES,
  ORDER_PAYMENT_STATUS_VALUES,
  ORDER_FULFILLMENT_STATUS_VALUES,
  ORDER_REFUND_STATUS_VALUES,
  RESERVATION_STATUS_VALUES,
  createOrderRequestSchema,
  orderItemViewSchema,
  orderViewSchema,
  adminOrderViewSchema,
  adminOrderListResponseSchema,
  adminOrderListQuerySchema,
  releaseExpiredResponseSchema,
  type CreateOrderRequest,
  type OrderItemView,
  type OrderView,
  type AdminOrderView,
  type AdminOrderListResponse,
  type AdminOrderListQuery,
  deliverEntitlementsResponseSchema,
  buyerOrderListQuerySchema,
  buyerOrderListResponseSchema,
  collectibleListQuerySchema,
  collectibleListResponseSchema,
  collectibleViewSchema,
  issueEntitlementsResponseSchema,
  reconcileRevocationsResponseSchema,
  type BuyerOrderListResponse,
  type CollectibleListResponse,
  type CollectibleView,
  type DeliverEntitlementsResponse,
  type ReconcileRevocationsResponse,
  type IssueEntitlementsResponse,
  type ReleaseExpiredResponse,
  PAYMENT_ATTEMPT_STATUS_VALUES,
  checkoutSessionResponseSchema,
  paymentAttemptViewSchema,
  webhookReceiptViewSchema,
  adminOrderPaymentsSchema,
  adminOrderDetailSchema,
  type CheckoutSessionResponse,
  type PaymentAttemptView,
  type WebhookReceiptView,
  type AdminOrderPayments,
  type AdminOrderDetail,
  // 問い合わせ対応（`UD-121`）
  ORDER_TIMELINE_KIND_VALUES,
  ORDER_NOTE_MAX_LENGTH,
  adminOrderEmailLookupSchema,
  orderTimelineEntrySchema,
  adminOrderTimelineResponseSchema,
  createOrderNoteRequestSchema,
  orderNoteViewSchema,
  adminOrderNotesResponseSchema,
  type AdminOrderEmailLookup,
  type OrderTimelineEntryView,
  type AdminOrderTimelineResponse,
  type CreateOrderNoteRequest,
  type OrderNoteView,
  type AdminOrderNotesResponse,
} from './order';

export {
  LEGAL_DOCUMENT_KIND_VALUES,
  LEGAL_VERSION_STATUS_VALUES,
  legalVersionSchema,
  legalVersionListResponseSchema,
  publicLegalDocumentSchema,
  publishLegalVersionRequestSchema,
  legalConsentStatusSchema,
  recordConsentRequestSchema,
  saveLegalDraftRequestSchema,
  tokushohoFieldsSchema,
  type LegalVersionView,
  type LegalVersionListResponse,
  type PublicLegalDocument,
  type PublishLegalVersionRequest,
  type LegalConsentStatus,
  type RecordConsentRequest,
  type SaveLegalDraftRequest,
  type TokushohoFieldsInput,
  renderLegalBody,
  checkoutNoticeFrom,
  CHECKOUT_NOTICE_FIELD_KEYS,
  type CheckoutLegalNotice,
  type LegalBlock,
  type LegalDocumentKind,
} from './legal';

export {
  PAYMENT_CREDENTIAL_STATUS_VALUES,
  paymentCredentialSchema,
  paymentCredentialListResponseSchema,
  registerPaymentCredentialRequestSchema,
  activatePaymentCredentialRequestSchema,
  type PaymentCredentialView,
  type PaymentCredentialListResponse,
  type RegisterPaymentCredentialRequest,
  type ActivatePaymentCredentialRequest,
} from './payment-credential';

export {
  TRANSFER_FEE_BEARER_VALUES,
  settlementSettingsSchema,
  settlementSettingsResponseSchema,
  updateSettlementSettingsRequestSchema,
  type SettlementSettingsView,
  type SettlementSettingsResponse,
  type UpdateSettlementSettingsRequest,
} from './settlement';

export {
  REFUND_REASON_VALUES,
  REFUND_RECORD_STATUS_VALUES,
  REFUND_INITIATOR_VALUES,
  refundRecordSchema,
  refundListResponseSchema,
  createRefundRequestSchema,
  refundResultSchema,
  type CreateRefundRequest,
  type RefundListResponse,
  type RefundRecordViewDto,
  type RefundResult,
} from './refund';

export {
  PAYOUT_STATUS_VALUES,
  payoutPeriodKeySchema,
  payoutSchema,
  payoutLineSchema,
  payoutListResponseSchema,
  payoutDetailResponseSchema,
  payoutListQuerySchema,
  closePayoutPeriodRequestSchema,
  closePayoutPeriodResponseSchema,
  type ClosePayoutPeriodRequest,
  type ClosePayoutPeriodResponse,
  type PayoutDetailResponse,
  type PayoutLineViewDto,
  type PayoutListQuery,
  type PayoutListResponse,
  type PayoutViewDto,
} from './payout';

export {
  DISPLAY_NAME_MAX,
  creatorProfileSchema,
  updateCreatorProfileRequestSchema,
  type CreatorProfileView,
  type UpdateCreatorProfileRequest,
} from './profile';

export {
  OPERATIONS_REVIEW_REASON_VALUES,
  OPERATIONS_REVIEW_STATUS_VALUES,
  operationsReviewSchema,
  operationsReviewListResponseSchema,
  resolveOperationsReviewRequestSchema,
  type OperationsReviewListResponse,
  type OperationsReviewView,
  type ResolveOperationsReviewRequest,
} from './operations-review';

// --- 購入者への知らせ（P0-4） ---------------------------------------------
export {
  NOTIFICATION_EVENT_TYPE_VALUES,
  NOTIFICATION_STATUS_VALUES,
  createNotificationTemplateRequestSchema,
  notificationHistoryListResponseSchema,
  notificationHistoryQuerySchema,
  notificationHistorySchema,
  notificationTemplateListResponseSchema,
  notificationTemplateSchema,
  sendNotificationsResponseSchema,
} from './notification';
export type {
  CreateNotificationTemplateRequest,
  NotificationHistoryListResponse,
  NotificationHistoryQuery,
  NotificationHistoryView,
  NotificationTemplateListResponse,
  NotificationTemplateView,
  SendNotificationsResponse,
} from './notification';

// --- 運営ダッシュボード（P0-6） -------------------------------------------
export {
  consistencyFindingSchema,
  consistencyResponseSchema,
  entitlementAdminDetailSchema,
  entitlementAdminListResponseSchema,
  entitlementAdminQuerySchema,
  entitlementAdminSchema,
  operationsDashboardResponseSchema,
  operationsIndicatorSchema,
  OPERATIONS_SEVERITIES,
  redeliverResponseSchema,
  retryIssuanceResponseSchema,
} from './operations';
export type {
  ConsistencyFindingView,
  ConsistencyResponse,
  EntitlementAdminDetailView,
  EntitlementAdminListResponse,
  EntitlementAdminQuery,
  EntitlementAdminView,
  OperationsDashboardResponse,
  OperationsIndicatorView,
  OperationsSeverity,
  RedeliverResponse,
  RetryIssuanceResponse,
} from './operations';

// --- 本番販売ガード（P0-7） -----------------------------------------------
export {
  attestationListResponseSchema,
  attestationSchema,
  mailCheckResponseSchema,
  productionReadinessCheckSchema,
  productionReadinessResponseSchema,
  recordAttestationRequestSchema,
} from './production';
export type {
  AttestationListResponse,
  AttestationView,
  MailCheckResponse,
  ProductionReadinessCheckView,
  ProductionReadinessResponse,
  RecordAttestationRequest,
} from './production';
