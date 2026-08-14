/**
 * `@sengoku/auth` — 認証の検証境界と、認可判定。
 *
 * 責務:
 *  - アクセストークン検証の**ポート定義**（実装方式は UD-801 で未決定）
 *  - ロールの定義と、`can(actor, action, resource)` による**純粋な認可判定**
 *  - アカウント解決のポート定義
 *
 * 責務ではないもの:
 *  - 資格情報の管理（Supabase Auth 側の責務。パスワードもハッシュも保持しない）
 *  - HTTP の知識（NestJS Guard は `apps/api` 側に置き、本パッケージの関数を呼ぶだけにする）
 *  - DB アクセス（`AccountLookupPort` の実装は `@sengoku/database`）
 */
export {
  ROLES,
  ACTIONS,
  canAtRoleLevel,
  requiresOwnership,
  ANONYMOUS,
  can,
  isAllowed,
  type Role,
  type Action,
  type Actor,
  type Resource,
  type AuthorizationDecision,
  type DenyReason,
} from './authorization';

export type {
  TokenVerifierPort,
  TokenVerificationResult,
  TokenVerificationFailure,
  VerifiedIdentity,
  AccountRecord,
  AccountLookupPort,
} from './token';
