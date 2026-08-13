/**
 * `@sengoku/observability` — 構造化ログと相関ID。
 *
 * 責務:
 *  - JSON 構造化ログの生成
 *  - 秘匿値の**自動マスキング**（規律ではなく仕組みで守る）
 *  - リクエスト単位の相関ID伝播
 *
 * 責務ではないもの:
 *  - 業務上の判断（何をログに出すかは呼び出し側が決める）
 *  - 監視基盤への送信（UD-1102 で未決定）
 */
export {
  createLogger,
  runWithRequestContext,
  currentRequestId,
  type Logger,
  type LoggerOptions,
  type LogLevel,
  type RequestContext,
} from './logger';

export { redact, REDACTED, SENSITIVE_KEY_PATTERNS } from './redact';
