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

export interface SupabaseAuthTargets {
  readonly AUTH_PROVIDER?: string;
  readonly SUPABASE_JWT_ISSUER?: string | undefined;
  readonly SUPABASE_JWT_AUDIENCE?: string | undefined;
  readonly SUPABASE_JWKS_URL?: string | undefined;
}

/**
 * Supabase での検証に必要な設定が揃っているか（`UD-801`）。
 *
 * ⚠️ **設定が欠けたまま起動させない。** 起動すると、
 * **すべてのログインが 401 になる**。利用者からは「自分の入力が悪い」
 * ようにしか見えず、何度もやり直したうえで諦める。
 * 気付けない失敗は、止まる失敗より重い。
 */
export function assertSupabaseAuthConfig(env: SupabaseAuthTargets): void {
  if (env.AUTH_PROVIDER !== 'supabase') {
    return;
  }
  const reasons: string[] = [];
  const required = [
    ['SUPABASE_JWT_ISSUER', env.SUPABASE_JWT_ISSUER],
    ['SUPABASE_JWT_AUDIENCE', env.SUPABASE_JWT_AUDIENCE],
    ['SUPABASE_JWKS_URL', env.SUPABASE_JWKS_URL],
  ] as const;

  for (const [name, value] of required) {
    if (value === undefined || value === '') {
      reasons.push(`${name}: AUTH_PROVIDER が supabase なのに設定されていない`);
    }
  }

  // ⚠️ **https に限る。** 平文で鍵束を取りに行くと、経路上で差し替えられる。
  //    差し替えられた鍵で検証が通れば、偽のトークンを本物として受け入れる。
  //    ⚠️ 値そのものは理由に載せない。ホスト名が混ざる。
  for (const [name, value] of [
    ['SUPABASE_JWKS_URL', env.SUPABASE_JWKS_URL],
    ['SUPABASE_JWT_ISSUER', env.SUPABASE_JWT_ISSUER],
  ] as const) {
    if (value !== undefined && value !== '' && !value.startsWith('https://')) {
      reasons.push(`${name}: https でなければならない`);
    }
  }

  if (reasons.length > 0) {
    throw new UnsafeEnvironmentError(reasons);
  }
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

export interface ClaimApiTargets {
  readonly CLAIM_API_ENABLED: boolean;
  readonly CLAIM_HMAC_KEYS?: string | undefined;
}

/**
 * Claim API の設定が揃っているか。
 *
 * ⚠️ **有効なのに鍵が無い状態で起動させない。**
 * 起動してしまうと、OVEW Wallet からの要求が全部 403 で落ちる。
 * しかも本システムから見れば「署名が合わない要求が来ている」だけなので、
 * **攻撃と設定漏れの区別がつかない。**
 */
export function assertClaimApiConfig(env: ClaimApiTargets): void {
  if (!env.CLAIM_API_ENABLED) {
    return;
  }
  if (env.CLAIM_HMAC_KEYS === undefined || env.CLAIM_HMAC_KEYS === '') {
    throw new UnsafeEnvironmentError([
      'CLAIM_HMAC_KEYS: Claim API が有効なのに HMAC の鍵が設定されていない',
    ]);
  }
  // 形が壊れていれば、鍵が 1 本も読めないまま起動してしまう。
  if (Object.keys(parseHmacKeys(env.CLAIM_HMAC_KEYS)).length === 0) {
    throw new UnsafeEnvironmentError([
      'CLAIM_HMAC_KEYS: 形式が正しくない（鍵ID:秘密鍵 をカンマ区切りで指定する）',
    ]);
  }
}

export interface WalletDeliveryTargets {
  readonly WALLET_DELIVERY_ENABLED: boolean;
  readonly WALLET_DELIVERY_ENDPOINT?: string | undefined;
  readonly WALLET_DELIVERY_KEY_ID?: string | undefined;
  readonly WALLET_DELIVERY_SECRET?: string | undefined;
}

/**
 * Wallet 配送の設定が揃っているか。
 *
 * ⚠️ **有効なのに宛先や鍵が無い状態で起動させない。**
 * 起動すると受取は成立し続け、配送だけが全件失敗して溜まる。
 * しかも利用者の画面は「お届け中」のままなので、誰も異常に気づけない。
 *
 * ⚠️ **送信先は `https` に限る。**
 * 平文で送ると、common_user_id と作品情報が経路上に出る。
 */
export function assertWalletDeliveryConfig(env: WalletDeliveryTargets): void {
  if (!env.WALLET_DELIVERY_ENABLED) {
    return;
  }
  const reasons: string[] = [];
  if (env.WALLET_DELIVERY_ENDPOINT === undefined || env.WALLET_DELIVERY_ENDPOINT === '') {
    reasons.push('WALLET_DELIVERY_ENDPOINT: 配送が有効なのに送信先が設定されていない');
  } else if (!env.WALLET_DELIVERY_ENDPOINT.startsWith('https://')) {
    // ⚠️ 値そのものは載せない。ホスト名や資格情報が混ざりうる。
    reasons.push('WALLET_DELIVERY_ENDPOINT: https でなければならない');
  }
  if (env.WALLET_DELIVERY_KEY_ID === undefined || env.WALLET_DELIVERY_KEY_ID === '') {
    reasons.push('WALLET_DELIVERY_KEY_ID: 配送が有効なのに鍵IDが設定されていない');
  }
  if (env.WALLET_DELIVERY_SECRET === undefined || env.WALLET_DELIVERY_SECRET === '') {
    reasons.push('WALLET_DELIVERY_SECRET: 配送が有効なのに秘密鍵が設定されていない');
  }
  if (reasons.length > 0) {
    throw new UnsafeEnvironmentError(reasons);
  }
}

export interface MediaStorageTargets {
  readonly MEDIA_STORAGE_PROVIDER: string;
  readonly MEDIA_PUBLIC_BASE_URL?: string | undefined;
  readonly R2_ACCOUNT_ID?: string | undefined;
  readonly R2_BUCKET?: string | undefined;
  readonly R2_ACCESS_KEY_ID?: string | undefined;
  readonly R2_SECRET_ACCESS_KEY?: string | undefined;
}

/**
 * 画像の保存先の設定が揃っているか（`UD-508`）。
 *
 * ⚠️ **`r2` なのに設定が欠けた状態で起動させない。**
 * 起動すると画像のアップロードだけが失敗する。カタログの登録は
 * 途中まで進むので、**画像が無い作品ができあがる**。
 * それが Wallet へ配送される段になって初めて表面化する。
 */
export function assertMediaStorageConfig(env: MediaStorageTargets): void {
  if (env.MEDIA_STORAGE_PROVIDER !== 'r2') {
    return;
  }
  const reasons: string[] = [];
  const required = [
    ['MEDIA_PUBLIC_BASE_URL', env.MEDIA_PUBLIC_BASE_URL],
    ['R2_ACCOUNT_ID', env.R2_ACCOUNT_ID],
    ['R2_BUCKET', env.R2_BUCKET],
    ['R2_ACCESS_KEY_ID', env.R2_ACCESS_KEY_ID],
    ['R2_SECRET_ACCESS_KEY', env.R2_SECRET_ACCESS_KEY],
  ] as const;

  for (const [name, value] of required) {
    if (value === undefined || value === '') {
      reasons.push(`${name}: 画像の保存先が r2 なのに設定されていない`);
    }
  }

  // ⚠️ **https に限る。** 平文で配ると、経路上で差し替えられる。
  //    ⚠️ 値そのものは載せない。ホスト名が混ざる。
  if (
    env.MEDIA_PUBLIC_BASE_URL !== undefined &&
    env.MEDIA_PUBLIC_BASE_URL !== '' &&
    !env.MEDIA_PUBLIC_BASE_URL.startsWith('https://')
  ) {
    reasons.push('MEDIA_PUBLIC_BASE_URL: https でなければならない');
  }

  if (reasons.length > 0) {
    throw new UnsafeEnvironmentError(reasons);
  }
}

export interface StagingFixtureTargets {
  readonly NODE_ENV: string;
  readonly APP_ENV: string;
  readonly ENABLE_STAGING_FIXTURES: boolean;
}

/**
 * staging Fixture を実行してよいか（PR-NW04 §9）。
 *
 * ⚠️ **2 つの条件を両方満たすことを要求する。**
 * フラグ 1 本にすると、本番の環境変数へ 1 行足しただけで
 * 本番DBに偽の受取権が作れてしまう。逆に `NODE_ENV` だけにすると、
 * 誤って `development` で起動した本番でも通ってしまう。
 * **片方だけでは通らない**ことが、この関数の存在理由。
 */
export function assertStagingFixtureAllowed(env: StagingFixtureTargets): void {
  const reasons: string[] = [];
  if (env.NODE_ENV === 'production' || env.APP_ENV === 'production') {
    reasons.push('本番環境では staging Fixture を実行できない');
  }
  if (!env.ENABLE_STAGING_FIXTURES) {
    reasons.push('ENABLE_STAGING_FIXTURES: staging Fixture が有効化されていない');
  }
  if (reasons.length > 0) {
    throw new UnsafeEnvironmentError(reasons);
  }
}

/**
 * `鍵ID:秘密鍵,鍵ID:秘密鍵` を表に変換する。
 *
 * ⚠️ **失敗しても内容を例外へ載せない。** 秘密鍵がそのままログへ出る。
 * 読めなかった項目は黙って捨て、件数だけを呼び出し元の判断材料にする。
 */
export function parseHmacKeys(raw: string): Readonly<Record<string, string>> {
  const keys: Record<string, string> = {};
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (trimmed === '') continue;
    // 秘密鍵に ':' が含まれても壊れないよう、最初の 1 個だけで区切る。
    const separator = trimmed.indexOf(':');
    if (separator <= 0) continue;
    const keyId = trimmed.slice(0, separator).trim();
    const secret = trimmed.slice(separator + 1).trim();
    if (keyId === '' || secret === '') continue;
    keys[keyId] = secret;
  }
  return keys;
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
