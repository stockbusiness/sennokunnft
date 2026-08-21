/**
 * `@sengoku/database` — 永続化層。
 *
 * 責務:
 *  - Prisma スキーマ（データモデルの正）
 *  - Prisma Client の生成と、接続の生成関数
 *  - `@sengoku/domain` が定義したリポジトリポートの実装（Phase 2 以降）
 *
 * 責務ではないもの:
 *  - 業務判断（ドメイン層に置く）
 *  - HTTP の知識
 *
 * ✅ Phase 1 ではスキーマ定義と Client 生成のみを行い、
 *    マイグレーションの生成・適用、本番DBへの接続は行わない。
 */
export { PrismaAccountRepository } from './repositories/account.repository';
export { PrismaCommonUserLinkRepository } from './repositories/common-user-link.repository';
export {
  PrismaAuditLogRepository,
  PrismaAuditLogReadRepository,
} from './repositories/audit.repository';
export { PrismaArtworkRepository } from './repositories/artwork.repository';
export { PrismaListingRepository } from './repositories/listing.repository';
export { PrismaIdempotencyStore } from './repositories/idempotency.repository';
export { PrismaSettlementSettingsRepository } from './repositories/settlement.repository';
export { PrismaRefundRepository } from './repositories/refund.repository';
export { PrismaEntitlementIssuanceRepository } from './repositories/issuance.repository';
export { PrismaCollectibleRepository } from './repositories/collectible.repository';
export { PrismaCreatorProfileRepository } from './repositories/profile.repository';
export { PrismaPayoutRepository, PayoutNotEditableError } from './repositories/payout.repository';

export { PrismaOrderRepository, PrismaOrderNoteRepository } from './repositories/order.repository';
export { PrismaPaymentRepository } from './repositories/payment.repository';

export { PrismaNonceStore } from './repositories/nonce.repository';

export { PrismaClaimRepository } from './repositories/claim.repository';

export {
  PrismaWalletDeliveryOutboxRepository,
  enqueueWalletDeliveryIdempotent,
  supersedePendingGrantedEvents,
} from './repositories/wallet-delivery.repository';
export {
  PrismaOperationsReviewRepository,
  openOperationsReview,
} from './repositories/operations-review.repository';
export { PrismaRevocationReconcileRepository } from './repositories/revocation-reconcile.repository';
export { PrismaWalletDeliveryAdminRepository } from './repositories/wallet-delivery-admin.repository';

export { encodeCursor, decodeCursor, type Cursor } from './repositories/mappers';

export {
  createPrismaClient,
  checkDatabaseConnection,
  type DatabaseConnectionCheck,
  type PrismaClientLike,
  type PrismaClient,
} from './client';

export { ENTITLEMENT_CLAIM_SQL, MINT_JOB_ACQUIRE_SQL, IDEMPOTENCY_CONSTRAINTS } from './invariants';
export {
  PrismaStaffInvitationRepository,
  PrismaStaffMemberRepository,
} from './repositories/staff.repository';
export { PrismaIntegrationRepository } from './repositories/integration.repository';

export { PrismaPlatformFeeRateReader } from './repositories/platform-fee-rate.repository';

export { PrismaPaymentCredentialRepository } from './repositories/payment-credential.repository';

export {
  PrismaLegalDocumentRepository,
  PrismaLegalConsentRepository,
} from './repositories/legal.repository';

// --- 購入者への知らせ（P0-4） ---------------------------------------------
export { PrismaNotificationOutboxRepository } from './repositories/notification.repository';
export { PrismaNotificationTemplateRepository } from './repositories/notification-template.repository';
export {
  PrismaAuthSubjectLookup,
  PrismaNotificationHistoryRepository,
} from './repositories/notification-history.repository';
export { PrismaNotificationSweepRepository } from './repositories/notification-sweep.repository';
export type { NotifiableEntitlement } from './repositories/notification-sweep.repository';
export { PrismaOperationsRepository } from './repositories/operations.repository';
// 本番販売ガード（P0-7）。
export {
  PrismaAttestationRepository,
  PrismaProductionReadinessRepository,
} from './repositories/production.repository';
export { PrismaEntitlementAdminRepository } from './repositories/entitlement-admin.repository';
export type {
  EntitlementAdminDetail,
  EntitlementAdminPage,
  EntitlementAdminQuery,
  EntitlementAdminRow,
} from './repositories/entitlement-admin.repository';

// 顧客サポート（P1-1）。
export {
  PrismaAccountNoteRepository,
  PrismaCustomerDirectoryRepository,
  PrismaEmailChangeRequestRepository,
} from './repositories/customer.repository';

// 作家さま運営（P1-2）。
export {
  PrismaCreatorEarningsRepository,
  PrismaCreatorProfileDetailRepository,
  PrismaPayoutAccountRepository,
} from './repositories/creator.repository';
