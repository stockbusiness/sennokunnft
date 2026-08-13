import { expect, test } from '@playwright/test';

/**
 * スモークテスト。
 *
 * ⚠️ 想定外の外部通信をテスト失敗にする。
 * 「気付かないうちに本番サービスへ繋いでいた」状態を検知するため
 * （TEST_STRATEGY.md §4）。
 */
test.beforeEach(async ({ page }) => {
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const isLocal = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
    if (!isLocal) {
      throw new Error(`外部への通信が発生しました: ${url.origin}`);
    }
    await route.continue();
  });
});

test('トップページが表示される', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});

test('セキュリティヘッダが付与されている', async ({ page }) => {
  const response = await page.goto('/');
  const headers = response?.headers() ?? {};
  expect(headers['x-content-type-options']).toBe('nosniff');
  // Claim URL がリファラ経由で外部へ漏れるのを防ぐ。
  expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
});

test('web のヘルスチェックが応答する', async ({ request }) => {
  const response = await request.get('/api/health');
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ status: 'ok', service: 'web' });
});

/**
 * API に繋がらないときの挙動。
 *
 * CI では API を起動していないので、ここが実際に通る経路になる。
 * 一覧が出せないことと、サイト全体が壊れることは別で、
 * 後者にしてしまうと復旧までの体感被害が大きい。
 */
test('API が利用できなくてもトップページが壊れない', async ({ page }) => {
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  // 例外画面ではなく、案内が出ていること。
  await expect(page.getByRole('status')).toBeVisible();
});

/**
 * API が落ちているときに「存在しない」と断定しない。
 *
 * 404 は「その作品は無い」という主張であり、
 * 実際には API に問い合わせられなかっただけかもしれない。
 * 一時的な障害を恒久的な不在として伝えると、利用者は諦めてしまう。
 */
test('API が利用できないとき、作品詳細を 404 と断定しない', async ({ page }) => {
  const response = await page.goto('/artworks/some-artwork');
  expect(response?.status()).not.toBe(404);
  await expect(page.getByRole('status')).toBeVisible();
});
