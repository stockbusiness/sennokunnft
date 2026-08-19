/**
 * `@sengoku/config` — 環境変数の型検証と、リポジトリ共通のビルド設定。
 *
 * 責務:
 *  - すべてのプロセスの環境変数スキーマを一箇所で定義する
 *  - 起動時に一括検証し、不足していれば **安全に起動失敗**させる
 *  - 検証エラーに **値を含めない**（SECURITY_DESIGN.md §3.3）
 *
 * 責務ではないもの:
 *  - 業務ロジック（`@sengoku/domain` の担当）
 *  - 外部サービスへの接続（`@sengoku/integrations` の担当）
 *
 * TypeScript / ESLint / Prettier の共有設定は、本パッケージのルートにある
 * `tsconfig.*.json` と `eslint.base.mjs` を各パッケージから相対パスで参照する。
 * ビルド前でも解決できるよう、これらは意図的に `dist` を経由しない。
 */
export {
  parseEnv,
  loadEnv,
  formatEnvProblems,
  type EnvParseResult,
  type EnvProblem,
  type LoadEnvOptions,
} from './env/parse';

export {
  APP_ENVS,
  LOG_LEVELS,
  baseEnvSchema,
  apiEnvSchema,
  workerEnvSchema,
  webEnvSchema,
  type AppEnv,
  type LogLevel,
  type BaseEnv,
  type ApiEnv,
  type WorkerEnv,
  type WebEnv,
} from './env/schema';

export {
  UnsafeEnvironmentError,
  assertPhaseOneIntegrationLimits,
  assertProductionSafety,
  assertCommonUserLinkingConfig,
  assertClaimApiConfig,
  assertWalletDeliveryConfig,
  assertMediaStorageConfig,
  assertSupabaseAuthConfig,
  assertStripeConfig,
  STRIPE_TEST_KEY_PREFIX,
  STRIPE_LIVE_KEY_PREFIX,
  assertStagingFixtureAllowed,
  parseHmacKeys,
  type IntegrationTargets,
  type CommonUserLinkingTargets,
  type ClaimApiTargets,
  type WalletDeliveryTargets,
  type MediaStorageTargets,
  type SupabaseAuthTargets,
  type StripeTargets,
  type StagingFixtureTargets,
} from './env/guards';
