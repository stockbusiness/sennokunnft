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
export { PrismaAuditLogRepository } from './repositories/audit.repository';
export { PrismaArtworkRepository } from './repositories/artwork.repository';
export { PrismaListingRepository } from './repositories/listing.repository';
export { encodeCursor, decodeCursor, type Cursor } from './repositories/mappers';

export {
  createPrismaClient,
  checkDatabaseConnection,
  type DatabaseConnectionCheck,
  type PrismaClientLike,
  type PrismaClient,
} from './client';

export { ENTITLEMENT_CLAIM_SQL, MINT_JOB_ACQUIRE_SQL, IDEMPOTENCY_CONSTRAINTS } from './invariants';
