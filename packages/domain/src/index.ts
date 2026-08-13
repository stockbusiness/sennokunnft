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
  ORDER_STATUSES,
  ENTITLEMENT_STATUSES,
  MINT_JOB_STATUSES,
  orderStateMachine,
  entitlementStateMachine,
  mintJobStateMachine,
  type OrderStatus,
  type EntitlementStatus,
  type MintJobStatus,
} from './state/machines';

export {
  evaluateClaim,
  mintIdempotencyPayload,
  type ClaimAttempt,
  type ClaimableEntitlement,
} from './entitlement/claim';

export {
  availableSupply,
  reserveSupply,
  releaseReservation,
  commitReservation,
  allocateSerialNumbers,
  type SupplyCounters,
} from './supply/supply';

export {
  BACKOFF_MINUTES,
  DEFAULT_MAX_ATTEMPTS,
  backoffMs,
  decideRetry,
  canCancelOnRefund,
  type MintJobSnapshot,
  type RetryDecision,
} from './mint/retry';

export type {
  ClockPort,
  IdGeneratorPort,
  ClaimTokenPort,
  IssuedClaimToken,
  IdempotencyKeyPort,
  PaymentGatewayPort,
  CheckoutSession,
  CheckoutSessionRequest,
  WebhookVerificationInput,
  VerifiedWebhook,
  MintingPort,
  MintRequest,
  MintSubmission,
  MintStatus,
  MintState,
  MetadataStoragePort,
  StoredMetadata,
  EventPublisherPort,
  DomainEventRecord,
} from './ports/index';
