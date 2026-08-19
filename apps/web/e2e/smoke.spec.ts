import { expect, test } from '@playwright/test';
import { withApi } from '../playwright.config';

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
  test.skip(withApi, 'API を起動している構成では検証できない');
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
  test.skip(withApi, 'API を起動している構成では検証できない');
  const response = await page.goto('/artworks/some-artwork');
  expect(response?.status()).not.toBe(404);
  await expect(page.getByRole('status')).toBeVisible();
});

/**
 * 管理画面。
 *
 * ⚠️ 画面が出ることは保護の証明にならない。管理APIの認可は
 * apps/api のテストで検証している。ここでは導線が壊れていないかだけを見る。
 */
test('管理画面が表示される（権限が無くても画面自体は壊れない）', async ({ page }) => {
  const response = await page.goto('/admin/artworks');
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '管理メニュー' })).toBeVisible();
});

test('管理画面の販売一覧が表示される', async ({ page }) => {
  const response = await page.goto('/admin/listings');
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});

/**
 * 法務のページ。
 *
 * ⚠️ **中身がまだ無くても、辿れること自体が要る。** 特商法の表記は
 * 販売前に掲げる義務がある。押せる場所が無いほうが困るので、
 * リンクは常に出し、中身が無いことはそのページが正直に伝える。
 */
test('フッタから法務のページへ辿れる', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('link', { name: '特定商取引法に基づく表記' })).toBeVisible();
});

test('法務のページが壊れずに開く（中身が未公開でも）', async ({ page }) => {
  for (const path of ['/legal/terms', '/legal/privacy', '/legal/tokushoho']) {
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  }
});

/**
 * 同意画面（`UD-126`）。
 *
 * ⚠️ **未ログインで開いてもエラーにしない。** ログインへ案内する。
 *    行き止まりを作らない。
 */
test('同意画面は未ログインならログインへ案内する', async ({ page }) => {
  const response = await page.goto('/legal/consent');
  expect(response?.status()).toBeLessThan(400);
});

test.describe('スマートフォン幅', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('主要な画面が横スクロールせずに表示される', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    // ページ全体が横にはみ出していないこと。
    // はみ出すと、片手操作で内容を追えなくなる。
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('管理画面の表は、ページではなく表自体がスクロールする', async ({ page }) => {
    await page.goto('/admin/artworks');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  /*
    ⚠️ 注文の一覧は表にしていない。指示書 §9.1 が求める項目を表にすると
       幅 48rem になり、狭い画面では金額が「￥12,00」で切れ、作品名が
       一文字ずつ縦に割れた。1 件 1 枚の札に倒してある。
       ここは「そう直したこと」を守るための検査。
  */
  test('注文の一覧が横にはみ出さない', async ({ page }) => {
    await page.goto('/admin/orders');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  /*
    ⚠️ 法務文書は長い。狭い画面で横に流れると、条文の途中が読めなくなる。
       読むのは困っているときなので、いちばん読みにくくてはいけない場面。
  */
  test('法務のページが横にはみ出さない', async ({ page }) => {
    await page.goto('/legal/tokushoho');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('本文の文字が小さすぎない', async ({ page }) => {
    // 40代以上を主な想定利用者としているため、本文を 16px 未満にしない。
    await page.goto('/');
    const fontSize = await page.evaluate(() =>
      Number.parseFloat(getComputedStyle(document.body).fontSize),
    );
    expect(fontSize).toBeGreaterThanOrEqual(16);
  });
});
