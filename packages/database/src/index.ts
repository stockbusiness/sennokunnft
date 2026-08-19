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
export { PrismaOrderRepository } from './repositories/order.repository';
export { PrismaPaymentRepository } from './repositories/payment.repository';

export { PrismaNonceStore } from './repositories/nonce.repository';

export { PrismaClaimRepository } from './repositories/claim.repository';

export { PrismaWalletDeliveryOutboxRepository } from './repositories/wallet-delivery.repository';
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

export { PrismaLegalDocumentRepository } from './repositories/legal.repository';
