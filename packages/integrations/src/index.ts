/**
 * `@sengoku/integrations` — 外部境界のアダプタ。
 *
 * 責務:
 *  - `@sengoku/domain` が定義したポートの実装
 *  - 暗号処理（ハッシュ・HMAC・乱数）といった技術的関心事
 *
 * 責務ではないもの:
 *  - 業務判断（ドメイン層に置く）
 *  - HTTP ルーティング（api 層に置く）
 *
 * ✅ **Phase 1 では Fake 実装のみを提供する。**
 * 実決済サービス（UD-702）・実ブロックチェーン（UD-501）への接続は行わない。
 * 実アダプタは、対応する未決定事項が確定してから追加する。
 */
export {
  SystemClock,
  FixedClock,
  UuidGenerator,
  SequentialIdGenerator,
  Sha256ClaimTokenService,
  HmacIdempotencyKeyService,
} from './system';

export { FakeMintingAdapter } from './fake-minting';

export { FakePaymentGateway, signWebhookPayload, WEBHOOK_TOLERANCE_MS } from './fake-payment';

export {
  DevTokenVerifier,
  createDevToken,
  type DevTokenClaims,
  type DevTokenVerifierOptions,
} from './dev-token-verifier';

export { LocalFileStorage, InMemoryStorage, generateStorageKey } from './local-storage';

export {
  AgencyCommonUserDirectory,
  FakeCommonUserDirectory,
  type AgencyCommonUserOptions,
} from './agency-common-user';
