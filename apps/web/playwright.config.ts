import { defineConfig, devices } from '@playwright/test';

const PORT = 3100;
const baseURL = `http://127.0.0.1:${PORT}`;

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
 * E2E は代表フローのみに絞る（TEST_STRATEGY.md §4）。
 * E2E は遅く不安定になりやすいため、数を増やさない。
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
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
  webServer: {
    command: `pnpm exec next start --port ${PORT}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      NODE_ENV: 'production',
      APP_ENV: 'test',
    },
  },
});
