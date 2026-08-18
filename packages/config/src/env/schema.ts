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
  /** 例: `https://<ref>.supabase.co`。末尾スラッシュなし。 */
  SUPABASE_URL: z.string().min(1).optional(),
  /** 例: `https://<ref>.supabase.co/auth/v1`。トークンの `iss` と一致させる。 */
  SUPABASE_JWT_ISSUER: z.string().min(1).optional(),
  /** Supabase の既定は `authenticated`。 */
  SUPABASE_JWT_AUDIENCE: z.string().min(1).default('authenticated'),
  /**
   * 鍵束の場所。例: `https://<ref>.supabase.co/auth/v1/.well-known/jwks.json`
   *
   * ⚠️ **公開情報であって秘密ではない。** 公開鍵しか含まない。
   * だからこそ、この方式では api に秘密を配らずに済む。
   */
  SUPABASE_JWKS_URL: z.string().min(1).optional(),
  /**
   * 認証トークンの検証方式（`UD-801` 決定済 2026-08-18）。
   *
   * - `supabase`: Supabase の JWKS（ES256）で検証する。**本番はこちら。**
   * - `dev`: 開発用。**誰でもトークンを作れる。**
   *
   * ⚠️ `dev` は本番で使えないよう起動時の組み合わせ検査で拒否する。
   * ⚠️ **既定を `supabase` にしない。** 手元やテストで設定が無いまま
   * 起動できなくなる。既定は緩く、本番は検査で締める向きにしてある。
   */
  AUTH_PROVIDER: z.enum(['dev', 'supabase']).default('dev'),
  AUTH_DEV_SECRET: z.string().min(8).optional(),
  PAYMENT_PROVIDER: z.enum(['fake']).default('fake'),
  PAYMENT_WEBHOOK_SECRET: z.string().min(1).optional(),
  MINT_PROVIDER: z.enum(['fake']).default('fake'),
  MINT_IDEMPOTENCY_SECRET: z.string().min(1).optional(),
  CLAIM_BASE_URL: z.url().default('http://localhost:3000/claims'),
  /**
   * 画像の保存先（`UD-508` で Cloudflare R2 に決定）。
   *
   * ⚠️ **既定は `local`。** ローカル保存は**再起動で消える**ので、
   * 本番・staging では必ず `r2` にする。`r2` にしたのに設定が
   * 揃っていなければ、起動時に拒否する（`assertMediaStorageConfig`）。
   */
  MEDIA_STORAGE_PROVIDER: z.enum(['local', 'r2']).default('local'),
  /** `local` のときの保存先ディレクトリ。 */
  MEDIA_STORAGE_DIR: z.string().min(1).default('./.media'),
  /** `local` のときの表示URLの前置き。保存するのはキーで、URLは実行時に解決する。 */
  MEDIA_PUBLIC_PREFIX: z.string().min(1).default('/media'),
  /**
   * `r2` のときの公開URLの前置き。R2 に割り当てた Custom Domain。
   *
   * ⚠️ **署名付き・期限付きの URL を指定しない。**
   * Wallet は受け取った URL を保存して表示に使うため、期限が切れると
   * **過去に渡した分の画像がまとめて壊れる**。
   */
  MEDIA_PUBLIC_BASE_URL: z.url().optional(),
  R2_ACCOUNT_ID: z.string().min(1).optional(),
  R2_BUCKET: z.string().min(1).optional(),
  R2_ACCESS_KEY_ID: z.string().min(1).optional(),
  /** ⚠️ 値そのものをリポジトリに入れない。`.env.example` には変数名だけ。 */
  R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),

  /**
   * 外部連携の資格情報を包む暗号鍵（管理画面・外部連携 指示書 §6.2）。
   *
   * 形式は `version:base64鍵,version:base64鍵`。鍵は 32 バイト。
   * ⚠️ **DB へ置かない。** 配備環境の Secret に置く。DB へ置くと、
   * DB を取られた時点で暗号化の意味が無くなる。
   * ⚠️ **消さない。** 消すと、包んだ資格情報を二度と開けない。
   */
  INTEGRATION_ENCRYPTION_KEYS: z.string().min(1).optional(),
  /** 新しく包むときに使う version。既定は `v1`。 */
  INTEGRATION_ENCRYPTION_ACTIVE_VERSION: z.string().min(1).default('v1'),

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

  /**
   * OVEW Wallet への配送（PR-NW04）。
   *
   * ⚠️ **Claim API とは別のフラグ。**
   * Claim は受け取りの記録まで、配送は Wallet へ届けるところまで。
   * 有効にすると受取確定と同時に配送本文が組み立てられ、
   * 組み立てられない作品（長期URLの画像が無い等）は**受取が失敗する**。
   * 画像の長期URL（Cloudflare R2）が整うまでは無効のままにする。
   */
  WALLET_DELIVERY_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  /** 送信先。`https://` の完全な URL。 */
  WALLET_DELIVERY_ENDPOINT: z.url().optional(),
  /** 署名に使う鍵ID。相手が発行する。 */
  WALLET_DELIVERY_KEY_ID: z.string().min(1).optional(),
  /** ⚠️ 値そのものをリポジトリに入れない。`.env.example` には変数名だけを書く。 */
  WALLET_DELIVERY_SECRET: z.string().min(8).optional(),
  /** 応答を待つ上限。待ち続けると配送ワーカーが詰まる。 */
  WALLET_DELIVERY_TIMEOUT_MS: integerFromEnv(1000, 60_000, 10_000),
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

  /**
   * OVEW Wallet への配送（PR-NW04）。
   *
   * ⚠️ **Claim API とは別のフラグ。**
   * Claim は受け取りの記録まで、配送は Wallet へ届けるところまで。
   * 有効にすると受取確定と同時に配送本文が組み立てられ、
   * 組み立てられない作品（長期URLの画像が無い等）は**受取が失敗する**。
   * 画像の長期URL（Cloudflare R2）が整うまでは無効のままにする。
   */
  WALLET_DELIVERY_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  /** 送信先。`https://` の完全な URL。 */
  WALLET_DELIVERY_ENDPOINT: z.url().optional(),
  /** 署名に使う鍵ID。相手が発行する。 */
  WALLET_DELIVERY_KEY_ID: z.string().min(1).optional(),
  /** ⚠️ 値そのものをリポジトリに入れない。`.env.example` には変数名だけを書く。 */
  WALLET_DELIVERY_SECRET: z.string().min(8).optional(),
  /** 応答を待つ上限。待ち続けると配送ワーカーが詰まる。 */
  WALLET_DELIVERY_TIMEOUT_MS: integerFromEnv(1000, 60_000, 10_000),
  /** 1 巡で送る件数の上限。相手の復旧直後に全件を叩きつけない。 */
  WALLET_DELIVERY_BATCH_SIZE: integerFromEnv(1, 500, 20),

  /** 受取ページの前置き。Fixture が出力する Claim URL に使う。 */
  CLAIM_BASE_URL: z.url().default('http://localhost:3000/claims'),

  /**
   * staging 動作確認用の Fixture を許可するか（PR-NW04 §9）。
   *
   * ⚠️ **これだけでは足りない。** `NODE_ENV != production` と**両方**を
   * 満たしたときにのみ実行できる。フラグ 1 本にすると、
   * 本番の環境変数へ 1 行足しただけで本番DBに偽の受取権が作れてしまう。
   */
  ENABLE_STAGING_FIXTURES: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  MINT_PROVIDER: z.enum(['fake']).default('fake'),
});

const webEnvObject = baseEnvObject.extend({
  WEB_API_BASE_URL: z.url().default('http://localhost:3001'),

  /**
   * ログイン（Supabase Auth）。`UD-801` 決定済 2026-08-18。
   *
   * ⚠️ **`NEXT_PUBLIC_` を付けない。** 付けるとブラウザのバンドルに入る。
   * ログインの送受信はすべてサーバー側で行い、トークンをブラウザの
   * JavaScript へ渡さない。
   */
  SUPABASE_URL: z.url().optional(),
  /**
   * 公開鍵（anon / publishable key）。
   *
   * ⚠️ **秘密鍵（service_role）を入れない。** あれは行単位の権限を
   * すべて飛び越える。ログインの送信に必要なのは公開鍵だけ。
   * 名前が似ているので、取り違えると被害が大きい。
   */
  SUPABASE_ANON_KEY: z.string().min(1).optional(),
  /**
   * メールのリンクの戻り先を組み立てるための、このサイトの入口。
   * 例: `https://sennokunnft-web.vercel.app`（末尾スラッシュなし）
   *
   * ⚠️ **要求の Host ヘッダから組み立てない。** 偽の Host を送られると、
   * ログインのリンクを攻撃者の場所へ向けさせられる。
   */
  WEB_PUBLIC_ORIGIN: z.url().optional(),
  /**
   * 表示に使うサイト名。
   *
   * ⚠️ **ここに既定値を書かない。**
   * 対外的なプロダクト名は未決定（`UD-101`）で、暫定名は
   * `apps/web/src/site.ts` の 1 か所に置いてある。ここにも名前を書くと
   * **暫定名が 2 か所になり、片方だけ直したときに画面の中で食い違う**。
   * 実際に、見出しはこの既定値・タブ名とフッタは `site.ts` という
   * 状態になっていた。未設定のまま `resolveSiteName` へ渡すこと。
   */
  NEXT_PUBLIC_SITE_NAME: z.string().min(1).optional(),
  /**
   * 運営がAPIを呼ぶときの資格情報（ログインが入るまでの暫定）。
   *
   * ⚠️ **サーバー側でのみ読む。** `NEXT_PUBLIC_` を付けていないので
   * ブラウザのバンドルには入らない。
   *
   * ⚠️ **ログインした人がいるときは使わない。** これは 1 本しか無く、
   * 全員が同じ人として扱われる。ログイン済みならその人のトークンを使う。
   * ここへ落ちるのは、ログイン機能を有効にしていない環境だけ。
   */
  ADMIN_DEV_TOKEN: z.string().min(8).optional(),

  /**
   * グループ内テストのための合言葉。正式名（`UD-101`）が決まるまでの暫定。
   *
   * 正式名・運営主体が未決定のあいだ、サイトを関係者だけに見せるための
   * 一時的な仕組み。**認証ではない。** 誰が見たかは分からず、
   * 教わった人が転送するのも止められない。
   *
   * ⚠️ **未設定のまま公開環境へ出したら、すべて拒否する**
   * （`assertSiteGateConfig`）。設定を忘れたときに素通しになるほうが
   * 危険なので、閉じる側へ倒す。
   *
   * ⚠️ 値そのものをリポジトリに入れない。`.env.example` には変数名だけ。
   */
  SITE_GATE_PASSWORD: z.string().min(8).optional(),
  /**
   * Vercel が自動で入れる環境の名前（`production` / `preview` / `development`）。
   *
   * ⚠️ **こちらで設定しない。** 手で設定できるようにすると、
   * 「本番なのに development と名乗る」状態を作れてしまい、
   * 合言葉の門を無効化する抜け道になる。
   */
  VERCEL_ENV: z.enum(['production', 'preview', 'development']).optional(),
});

export const baseEnvSchema = z.preprocess(stripEmptyValues, baseEnvObject);
export const apiEnvSchema = z.preprocess(stripEmptyValues, apiEnvObject);
export const workerEnvSchema = z.preprocess(stripEmptyValues, workerEnvObject);
export const webEnvSchema = z.preprocess(stripEmptyValues, webEnvObject);

export type BaseEnv = z.infer<typeof baseEnvObject>;
export type ApiEnv = z.infer<typeof apiEnvObject>;
export type WorkerEnv = z.infer<typeof workerEnvObject>;
export type WebEnv = z.infer<typeof webEnvObject>;
