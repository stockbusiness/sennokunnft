import { z } from 'zod';

export const APP_ENVS = ['local', 'test', 'staging', 'production'] as const;
export type AppEnv = (typeof APP_ENVS)[number];

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * 空文字を「未設定」として扱う。
 *
 * `.env.example` をコピーした直後は `API_PORT=` のように値が空になる。
 * 空文字を「設定済み」と解釈すると、既定値が効かず不親切なエラーになるため、
 * 検証前に取り除く。
 */
function stripEmptyValues(source: unknown): unknown {
  if (typeof source !== 'object' || source === null) {
    return source;
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    if (value !== '') {
      result[key] = value;
    }
  }
  return result;
}

/** 環境変数として渡される整数（文字列）を、範囲検証つきで数値へ変換する。 */
function integerFromEnv(min: number, max: number, fallback: number) {
  return z
    .string()
    .optional()
    .transform((value) => (value === undefined ? fallback : Number.parseInt(value, 10)))
    .refine((value) => Number.isSafeInteger(value) && value >= min && value <= max, {
      message: `must be an integer between ${String(min)} and ${String(max)}`,
    });
}

const baseEnvShape = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ENV: z.enum(APP_ENVS).default('local'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
};

const baseEnvObject = z.object(baseEnvShape);

/**
 * apps/api の設定。
 *
 * 決済・発行プロバイダの候補が `fake` のみなのは、決済事業者（UD-702）と
 * ブロックチェーン仕様（UD-501）がいずれも未決定であり、
 * **推測で実サービスを既定にしない**ため。決定後に候補を追加する。
 */
const apiEnvObject = baseEnvObject.extend({
  API_PORT: integerFromEnv(1, 65535, 3001),
  API_PUBLIC_ORIGIN: z.url().default('http://localhost:3000'),
  DATABASE_URL: z.string().min(1),
  SUPABASE_URL: z.string().min(1).optional(),
  SUPABASE_JWT_ISSUER: z.string().min(1).optional(),
  SUPABASE_JWT_AUDIENCE: z.string().min(1).optional(),
  SUPABASE_JWKS_URL: z.string().min(1).optional(),
  /**
   * 認証トークンの検証方式。
   *
   * 候補が `dev` しかないのは、検証方式（UD-801）が未決定で、
   * 共有シークレットか JWKS かが決まっていないため。
   * `dev` は誰でもトークンを作れるので、本番では使えないよう
   * 起動時の組み合わせ検査で拒否する。
   */
  AUTH_PROVIDER: z.enum(['dev']).default('dev'),
  AUTH_DEV_SECRET: z.string().min(8).optional(),
  PAYMENT_PROVIDER: z.enum(['fake']).default('fake'),
  PAYMENT_WEBHOOK_SECRET: z.string().min(1).optional(),
  MINT_PROVIDER: z.enum(['fake']).default('fake'),
  MINT_IDEMPOTENCY_SECRET: z.string().min(1).optional(),
  CLAIM_BASE_URL: z.url().default('http://localhost:3000/claims'),
  /** 画像の保存先ディレクトリ。本番ストレージは未決定（UD-508）。 */
  MEDIA_STORAGE_DIR: z.string().min(1).default('./.media'),
  /** 画像の表示URLの前置き。保存するのはキーで、URLは実行時に解決する。 */
  MEDIA_PUBLIC_PREFIX: z.string().min(1).default('/media'),

  /**
   * Claim API（OVEW Wallet 連携）。
   *
   * ⚠️ **既定は OFF**（指示書 §15「Feature Flag既定ON」禁止）。
   * OVEW Wallet 側の署名器が v1.1 FINAL へ揃い、
   * 固定ベクトルが両システムで一致してから ON にする。
   */
  CLAIM_API_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  /**
   * HMAC の鍵。`鍵ID:秘密鍵` をカンマ区切りで並べる。
   *
   * ⚠️ **複数書けるようにしてあるのは、鍵の入れ替え中に新旧どちらの署名も
   * 受け取れるようにするため。** 1 個しか持てないと、差し替えた瞬間に
   * 相手の要求が全部落ちる（`UD-1004`）。
   *
   * ⚠️ 値そのものをリポジトリに入れない。`.env.example` には変数名だけを書く。
   */
  CLAIM_HMAC_KEYS: z.string().min(1).optional(),
  /**
   * Claim API のレート制限（1 分あたり・鍵IDごと）。
   *
   * ⚠️ **`GET` を実利用より小さくしない。**
   * OVEW Wallet の Claim 画面は `DELIVERY_PENDING` のあいだ 5 秒間隔で
   * ポーリングする（1 セッションあたり毎分 12 回）。絞りすぎると
   * **攻撃ではなく正規の利用者が弾かれる。**しかも症状は
   * 「受け取り画面が進まない」で、原因に気づきにくい。
   */
  CLAIM_RATE_LIMIT_GET_PER_MIN: integerFromEnv(1, 1_000_000, 3000),
  CLAIM_RATE_LIMIT_POST_PER_MIN: integerFromEnv(1, 1_000_000, 300),
});

const workerEnvObject = baseEnvObject.extend({
  DATABASE_URL: z.string().min(1),
  WORKER_BATCH_SIZE: integerFromEnv(1, 1000, 10),
  WORKER_POLL_INTERVAL_MS: integerFromEnv(100, 3_600_000, 5000),

  /**
   * 共通顧客HUB（代理店システム）への連携。
   *
   * ⚠️ **既定は OFF。** 指示書 §16 のとおり、機能フラグはすべて既定で無効にする。
   * ON にしただけでは動かず、接続先と鍵が揃っていることを起動時に確かめる。
   */
  COMMON_USER_LINKING_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  /** 例: https://sengoku-ai.com（末尾スラッシュなし） */
  COMMON_USER_API_BASE_URL: z.string().url().optional(),
  /** 相手が発行した受信用APIキー。**リポジトリに入れない。** */
  COMMON_USER_API_KEY: z.string().min(8).optional(),
  /** 相手側で本システムを識別する固定値。 */
  COMMON_USER_SYSTEM_KEY: z.string().min(1).default('sennokuni-nft-market'),
  /**
   * 1 巡で処理する件数の上限。
   *
   * ⚠️ 上限が無いと、相手の復旧直後に溜まった全件を一気に送りつけ、
   * 復旧しかけた相手をもう一度落とす。
   */
  COMMON_USER_LINK_BATCH_SIZE: integerFromEnv(1, 500, 25),

  MINT_PROVIDER: z.enum(['fake']).default('fake'),
});

const webEnvObject = baseEnvObject.extend({
  WEB_API_BASE_URL: z.url().default('http://localhost:3001'),
  NEXT_PUBLIC_SITE_NAME: z.string().min(1).default('千ノ国NFTマーケット'),
  /**
   * 管理画面がAPIを呼ぶときの資格情報。
   *
   * ⚠️ **サーバー側でのみ読む。** `NEXT_PUBLIC_` を付けていないので
   * ブラウザのバンドルには入らない。
   * 認証プロバイダへ本接続しない Phase 2 の暫定手段（UD-801）。
   */
  ADMIN_DEV_TOKEN: z.string().min(8).optional(),
});

export const baseEnvSchema = z.preprocess(stripEmptyValues, baseEnvObject);
export const apiEnvSchema = z.preprocess(stripEmptyValues, apiEnvObject);
export const workerEnvSchema = z.preprocess(stripEmptyValues, workerEnvObject);
export const webEnvSchema = z.preprocess(stripEmptyValues, webEnvObject);

export type BaseEnv = z.infer<typeof baseEnvObject>;
export type ApiEnv = z.infer<typeof apiEnvObject>;
export type WorkerEnv = z.infer<typeof workerEnvObject>;
export type WebEnv = z.infer<typeof webEnvObject>;
