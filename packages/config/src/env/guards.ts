import type { AppEnv, LogLevel } from './schema';

/**
 * 環境設定の組み合わせが安全かを検査する。
 *
 * スキーマ検証（型・必須）とは別に、「型としては正しいが運用上危険な組み合わせ」を弾く。
 * 例: 本番環境なのに debug ログが有効、開発環境なのに実サービスへ接続。
 */
export class UnsafeEnvironmentError extends Error {
  public override readonly name = 'UnsafeEnvironmentError';
  constructor(public readonly reasons: readonly string[]) {
    super(`環境設定が安全でありません:\n${reasons.map((r) => `  - ${r}`).join('\n')}`);
  }
}

export interface IntegrationTargets {
  readonly APP_ENV: AppEnv;
  readonly LOG_LEVEL: LogLevel;
  readonly PAYMENT_PROVIDER?: string;
  readonly MINT_PROVIDER?: string;
  readonly AUTH_PROVIDER?: string;
  readonly DATABASE_URL?: string;
}

export interface CommonUserLinkingTargets {
  readonly COMMON_USER_LINKING_ENABLED: boolean;
  readonly COMMON_USER_API_BASE_URL?: string | undefined;
  readonly COMMON_USER_API_KEY?: string | undefined;
}

/**
 * 共通顧客HUB連携の設定が揃っているか。
 *
 * ⚠️ **有効なのに接続先や鍵が無い状態で起動させない。**
 * 起動してしまうと、解決が毎回失敗して全アカウントが PENDING に積み上がる。
 * しかも購入は続けられるので、**壊れていることに誰も気付かないまま進む。**
 * 気付けない失敗は、止まる失敗より重い。
 */
export function assertCommonUserLinkingConfig(env: CommonUserLinkingTargets): void {
  if (!env.COMMON_USER_LINKING_ENABLED) {
    return;
  }
  const reasons: string[] = [];
  if (env.COMMON_USER_API_BASE_URL === undefined || env.COMMON_USER_API_BASE_URL === '') {
    reasons.push('COMMON_USER_API_BASE_URL: 連携が有効なのに接続先が設定されていない');
  }
  if (env.COMMON_USER_API_KEY === undefined || env.COMMON_USER_API_KEY === '') {
    reasons.push('COMMON_USER_API_KEY: 連携が有効なのに API キーが設定されていない');
  }
  if (reasons.length > 0) {
    throw new UnsafeEnvironmentError(reasons);
  }
}

/** 接続先がローカル環境かどうかを、URL の host 部分だけを見て判定する。 */
function isLocalHost(connectionUrl: string): boolean {
  // 接続文字列には資格情報が含まれるため、パースに失敗しても内容をログに出さない。
  let host: string;
  try {
    host = new URL(connectionUrl).hostname;
  } catch {
    return false;
  }
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === 'db';
}

/**
 * Phase 1 の制約: 実決済・実ブロックチェーンへ接続しない。
 *
 * プロバイダ識別子が `fake` 以外に設定されていたら起動を拒否する。
 * 「設定を1つ書き換えるだけで本番に繋がる」状態を作らないための歯止め。
 */
export function assertPhaseOneIntegrationLimits(env: IntegrationTargets): void {
  const reasons: string[] = [];
  if (env.PAYMENT_PROVIDER !== undefined && env.PAYMENT_PROVIDER !== 'fake') {
    reasons.push(
      'PAYMENT_PROVIDER: Phase 1 では fake 以外を許可していない（決済事業者は UD-702 で未決定）',
    );
  }
  if (env.MINT_PROVIDER !== undefined && env.MINT_PROVIDER !== 'fake') {
    reasons.push(
      'MINT_PROVIDER: Phase 1 では fake 以外を許可していない（チェーンは UD-501 で未決定）',
    );
  }
  if (reasons.length > 0) {
    throw new UnsafeEnvironmentError(reasons);
  }
}

/**
 * 本番環境として起動するときに、明らかな設定事故を弾く。
 *
 * ここで検出するのは「起動してしまうと気付きにくい」種類の誤りに限る。
 */
export function assertProductionSafety(env: IntegrationTargets): void {
  if (env.APP_ENV !== 'production') {
    return;
  }
  const reasons: string[] = [];
  if (env.LOG_LEVEL === 'trace' || env.LOG_LEVEL === 'debug') {
    reasons.push('LOG_LEVEL: 本番で trace / debug は情報漏洩の恐れがあるため許可しない');
  }
  if (env.DATABASE_URL !== undefined && isLocalHost(env.DATABASE_URL)) {
    reasons.push('DATABASE_URL: 本番環境なのに接続先がローカルホストを指している');
  }
  if (env.AUTH_PROVIDER === 'dev') {
    // 開発用の検証は誰でもトークンを作れる。本番で有効になれば認証が無いに等しい。
    reasons.push('AUTH_PROVIDER: 本番で開発用のトークン検証（dev）は使用できない');
  }
  if (reasons.length > 0) {
    throw new UnsafeEnvironmentError(reasons);
  }
}
