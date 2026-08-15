import { defineConfig, devices } from '@playwright/test';

const WEB_PORT = 3100;
const API_PORT = 3101;
const baseURL = `http://127.0.0.1:${WEB_PORT}`;
const apiBaseURL = `http://127.0.0.1:${API_PORT}`;

/**
 * 既にブラウザが用意されている環境向けの逃げ道。
 *
 * Playwright は自身のバージョンに紐づくビルド番号のブラウザを探すため、
 * ブラウザが事前配置されている実行環境ではバージョン不一致で起動できない。
 * その場合に `PLAYWRIGHT_CHROMIUM_EXECUTABLE` で実行ファイルを直接指定する。
 *
 * CI では `playwright install --with-deps chromium` で正規のブラウザを取得するため、
 * この変数は設定しない（＝通常経路で動く）。
 */
const chromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;

/**
 * API も一緒に起動するか。
 *
 * `DATABASE_URL` があるときだけ API を立ち上げ、通しシナリオを実行する。
 * 無い場合は web だけを起動し、「API が落ちているときの挙動」を検証する。
 * どちらも実際に起こりうる状況なので、両方に価値がある。
 */
const databaseUrl = process.env.DATABASE_URL;
export const withApi = databaseUrl !== undefined && databaseUrl !== '';

/** 通しシナリオで使う署名鍵。テスト専用の固定値で、本番では使えない（起動時ガード）。 */
export const E2E_TOKEN_SECRET = 'e2e-admin-token-secret';
export const E2E_ISSUER = 'sennokunnft-e2e';
export const E2E_AUDIENCE = 'sennokunnft';
export { apiBaseURL };

interface ServerSpec {
  command: string;
  url: string;
  reuseExistingServer: boolean;
  timeout: number;
  env: Record<string, string>;
}

const apiServer: ServerSpec = {
  command: 'node ../api/dist/main.js',
  url: `${apiBaseURL}/healthz`,
  reuseExistingServer: !process.env.CI,
  timeout: 120_000,
  env: {
    NODE_ENV: 'production',
    APP_ENV: 'test',
    API_PORT: String(API_PORT),
    API_PUBLIC_ORIGIN: baseURL,
    DATABASE_URL: databaseUrl ?? '',
    AUTH_DEV_SECRET: E2E_TOKEN_SECRET,
    SUPABASE_JWT_ISSUER: E2E_ISSUER,
    SUPABASE_JWT_AUDIENCE: E2E_AUDIENCE,
    MEDIA_STORAGE_DIR: './.e2e-media',
    LOG_LEVEL: 'warn',
  },
};

const webServer: ServerSpec = {
  command: `pnpm exec next start --port ${String(WEB_PORT)}`,
  url: baseURL,
  reuseExistingServer: !process.env.CI,
  timeout: 120_000,
  env: {
    NODE_ENV: 'production',
    APP_ENV: 'test',
    WEB_API_BASE_URL: apiBaseURL,
    // ⚠️ サイト名を渡さない。本番と同じ経路（site.ts の暫定名）を通すため。
    //    ここだけ別名を入れると、名前の食い違いを E2E が素通りさせる。
    //
    // 管理画面から API を呼ぶための資格情報。E2E のセットアップが発行する。
    ADMIN_DEV_TOKEN: process.env.E2E_ADMIN_TOKEN ?? '',
  },
};

/**
 * E2E は代表フローのみに絞る（TEST_STRATEGY.md §4）。
 * E2E は遅く不安定になりやすいため、数を増やさない。
 */
export default defineConfig({
  testDir: './e2e',
  // 同じ DB を共有するため直列に実行する。
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL,
    trace: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(chromiumExecutable === undefined
          ? {}
          : { launchOptions: { executablePath: chromiumExecutable } }),
      },
    },
  ],
  webServer: withApi ? [apiServer, webServer] : [webServer],
});
