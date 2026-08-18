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
