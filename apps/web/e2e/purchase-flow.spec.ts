import { expect, test } from '@playwright/test';
import { createDevToken } from '@sengoku/integrations';
import {
  apiBaseURL,
  WEB_PORT,
  E2E_AUDIENCE,
  E2E_ISSUER,
  E2E_TOKEN_SECRET,
  withApi,
} from '../playwright.config';

/**
 * 購入手続き（決済 Phase P0・P1）を、実 API・実 DB に対して通す。
 *
 * ⚠️ **決済はしない。** 「決済準備中」まで。外部の決済画面へは飛ばさない。
 * ⚠️ **在庫が本当に減ることまで見る。** 画面に文字が出ただけでは、
 * 押さえが立ったかどうか分からない。
 */
test.describe(withApi ? '購入手続き' : '購入手続き（DB 未設定のため省略）', () => {
  test.skip(!withApi, 'DATABASE_URL が設定されていないため実行しない');

  const suffix = String(Date.now()).slice(-8);
  const slug = `e2e-buy-${suffix}`;

  function tokenFor(subject: string): string {
    return createDevToken(E2E_TOKEN_SECRET, {
      sub: subject,
      iss: E2E_ISSUER,
      aud: E2E_AUDIENCE,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
  }

  test('作品を出品し、購入者が申し込むと在庫が押さえられる', async ({ request, page, context }) => {
    const operator = tokenFor('seed-operator');
    const post = (path: string, body?: unknown) =>
      request.post(`${apiBaseURL}${path}`, {
        headers: { authorization: `Bearer ${operator}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { data: body }),
      });

    // --- 1. 販売中の作品をひとつ用意する ------------------------------------
    const created = await post('/api/v1/admin/artworks', {
      slug,
      title: `E2E購入 ${suffix}`,
      description: '購入手続きの通しシナリオで使う作品です。',
      maxSupply: 2,
    });
    expect(created.status()).toBe(201);
    const artwork = (await created.json()) as { id: string };

    const png = Buffer.alloc(1024);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    expect(
      (
        await request.post(`${apiBaseURL}/api/v1/admin/artworks/${artwork.id}/image`, {
          headers: { authorization: `Bearer ${operator}`, 'content-type': 'image/png' },
          data: png,
        })
      ).status(),
    ).toBe(200);
    expect((await post(`/api/v1/admin/artworks/${artwork.id}/publish`)).status()).toBe(200);

    const listingResponse = await post('/api/v1/admin/listings', {
      artworkId: artwork.id,
      priceAmount: 12000,
      priceCurrency: 'JPY',
    });
    expect(listingResponse.status()).toBe(201);
    const listing = (await listingResponse.json()) as { id: string };
    expect((await post(`/api/v1/admin/listings/${listing.id}/activate`)).status()).toBe(200);

    // --- 2. ログインしていなければ、申し込みではなくログインへ案内する ------
    // ⚠️ 追い返さない。売り切れの確認より先にログインを強いると、
    //    ログインし終えてから「買えません」と言うことになる。
    await page.goto(`/checkout/${listing.id}`);
    await expect(page.getByText('お申し込みにはログインが必要です')).toBeVisible();
    await expect(page.getByRole('button', { name: 'この内容で申し込む' })).toHaveCount(0);

    // --- 3. ログインして確認画面を開く --------------------------------------
    await context.addCookies([
      {
        name: 'sengoku_at',
        value: tokenFor(`e2e-buyer-${suffix}`),
        domain: '127.0.0.1',
        path: '/',
      },
      {
        name: 'sengoku_at_exp',
        value: String(Math.floor(Date.now() / 1000) + 3600),
        domain: '127.0.0.1',
        path: '/',
      },
    ]);

    await page.goto(`/checkout/${listing.id}`);
    await expect(page.getByRole('heading', { name: 'ご注文内容の確認' })).toBeVisible();
    await expect(page.getByText(`E2E購入 ${suffix}`)).toBeVisible();
    await expect(page.getByText('12,000')).toBeVisible();
    await expect(page.getByText('（税込）')).toBeVisible();

    // --- 4. 申し込むと「決済準備中」へ進む ----------------------------------
    await Promise.all([
      page.waitForURL(/\/orders\//),
      page.getByRole('button', { name: 'この内容で申し込む' }).click(),
    ]);
    await expect(page.getByRole('heading', { name: 'お申し込みを承りました' })).toBeVisible();
    await expect(page.getByText('ただいまお支払いのご用意をしています')).toBeVisible();
    // ⚠️ 「完了しました」と読める言葉を置かない。お支払いはまだ済んでいない。
    await expect(page.getByText('お支払いが完了しました')).toHaveCount(0);
    // ⚠️ 外部の決済画面へ飛ばさない。Phase P2 でつなぐ。
    expect(new URL(page.url()).host).toBe(`127.0.0.1:${String(WEB_PORT)}`);

    // --- 5. 在庫が押さえられている ------------------------------------------
    const detail = await request.get(`${apiBaseURL}/api/v1/artworks/${slug}`);
    const body = (await detail.json()) as { availableSupply: number; maxSupply: number };
    expect(body.maxSupply).toBe(2);
    expect(body.availableSupply).toBe(1);

    // --- 6. 運営の一覧に出る（金額の内訳つき） ------------------------------
    const orders = await request.get(`${apiBaseURL}/api/v1/admin/orders?limit=50`, {
      headers: { authorization: `Bearer ${operator}` },
    });
    expect(orders.status()).toBe(200);
    const list = (await orders.json()) as {
      items: { item: { titleSnapshot: string } | null; creatorAmount: number }[];
    };
    const mine = list.items.find((entry) => entry.item?.titleSnapshot === `E2E購入 ${suffix}`);
    expect(mine).toBeDefined();
    // 手数料率が未設定（0）なので、全額が出品者の取り分として記録される。
    expect(mine?.creatorAmount).toBe(12000);
  });
});
