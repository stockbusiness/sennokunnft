import { err, ok, type Result } from '../shared/result';
import { domainError, type DomainError } from '../shared/errors';
import type { IntegrationEnvironment, IntegrationService } from './service';

/**
 * 資格情報の交換（指示書 §7）。
 *
 * ⚠️ **新しい鍵をいきなり有効にしない。**
 * 「登録 → 待機 → 接続テスト → 有効化」の順に進む。有効化を登録と同時に
 * 行うと、間違った鍵を入れた瞬間に連携が止まり、しかも元の鍵は
 * 再表示できないため戻せない。**戻せる状態を必ず経由させる。**
 *
 * ⚠️ **平文はこの層に来ない。** ここで扱うのは状態だけ。
 * 包む・開くは `SecretCipherPort` の仕事。
 */

export type SecretStatus = 'pending' | 'active' | 'retired';

/** 同じサービスで複数の資格情報を持つための用途。 */
export const SECRET_PURPOSES = ['api_key', 'hmac_secret'] as const;
export type SecretPurpose = (typeof SECRET_PURPOSES)[number];

export function isSecretPurpose(value: string): value is SecretPurpose {
  return (SECRET_PURPOSES as readonly string[]).includes(value);
}

export interface IntegrationSecret {
  readonly id: string;
  readonly service: IntegrationService;
  readonly environment: IntegrationEnvironment;
  readonly purpose: SecretPurpose;
  readonly keyVersion: string;
  readonly lastFour: string;
  readonly status: SecretStatus;
  readonly activatedAt: Date | null;
  readonly retiredAt: Date | null;
  readonly createdAt: Date;
}

/**
 * 待機中の資格情報を有効にする。
 *
 * ⚠️ **接続テストの成功を条件にする。** 通らない鍵で連携を差し替えると、
 * 気づくのは送信が失敗し始めてから。しかも元の鍵は再表示できない。
 *
 * ⚠️ **古い成功で通さない。** 設定を変えたあとに、変える前の成功が
 * 残っていれば通ってしまう。`freshnessMs` を過ぎた結果は無効にする。
 */
export interface ActivateSecretInput {
  readonly secret: IntegrationSecret;
  /** いま有効な資格情報（同じ用途）。無ければ `null`。 */
  readonly current: IntegrationSecret | null;
  /** この資格情報に対する直近の接続テスト。無ければ `null`。 */
  readonly lastCheck: { readonly succeeded: boolean; readonly executedAt: Date } | null;
  readonly freshnessMs: number;
  readonly now: Date;
}

export interface ActivatedSecrets {
  readonly activated: IntegrationSecret;
  /** 入れ替わりで退役するもの。無ければ `null`。 */
  readonly retired: IntegrationSecret | null;
}

export function activateSecret(input: ActivateSecretInput): Result<ActivatedSecrets, DomainError> {
  const { secret, current, lastCheck, now } = input;

  if (secret.status !== 'pending') {
    return err(domainError('INTEGRATION_SECRET_NOT_PENDING', 'secret is not pending'));
  }
  if (lastCheck === null || !lastCheck.succeeded) {
    return err(domainError('INTEGRATION_CHECK_REQUIRED', 'no successful connection check'));
  }
  if (now.getTime() - lastCheck.executedAt.getTime() > input.freshnessMs) {
    return err(domainError('INTEGRATION_CHECK_STALE', 'connection check is too old'));
  }
  if (current !== null && current.purpose !== secret.purpose) {
    // 呼び出し側の取り違え。別の用途の鍵を巻き込んで退役させない。
    return err(domainError('INTEGRATION_SECRET_NOT_PENDING', 'purpose mismatch'));
  }

  return ok({
    activated: { ...secret, status: 'active', activatedAt: now },
    retired: current === null ? null : { ...current, status: 'retired', retiredAt: now },
  });
}

/**
 * 待機中のものを捨てる（指示書 §7-5「問題があれば旧versionへ戻す」）。
 *
 * ⚠️ **いま有効なものには触れない。** 捨てるのは、まだ使っていない
 * 待機中の行だけ。有効なものを外す操作は、新しいものを有効にする操作の
 * 裏側でしか起きない。
 */
export function discardPendingSecret(
  secret: IntegrationSecret,
  now: Date,
): Result<IntegrationSecret, DomainError> {
  if (secret.status !== 'pending') {
    return err(domainError('INTEGRATION_SECRET_NOT_PENDING', 'secret is not pending'));
  }
  return ok({ ...secret, status: 'retired', retiredAt: now });
}
