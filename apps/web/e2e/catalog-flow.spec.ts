import { expect, test } from '@playwright/test';
import { createDevToken } from '@sengoku/integrations';
import {
  apiBaseURL,
  E2E_AUDIENCE,
  E2E_ISSUER,
  E2E_TOKEN_SECRET,
  withApi,
} from '../playwright.config';

/**
 * 管理者の登録から購入者の閲覧までを、実 API・実 DB に対して通す。
 *
 * `DATABASE_URL` が無いときは丸ごと飛ばす。
 * ⚠️ CI では必ず DB を用意しているので、ここが飛ぶことはない。
 * 飛んだかどうかは Playwright の出力（skipped 件数）で分かる。
 */
test.describe(withApi ? '通しシナリオ' : '通しシナリオ（DB 未設定のため省略）', () => {
  test.skip(!withApi, 'DATABASE_URL が設定されていないため実行しない');

  /** 一意な接尾辞。同じ DB を再利用しても衝突しないようにする。 */
  const suffix = String(Date.now()).slice(-8);
  const slug = `e2e-artwork-${suffix}`;
  let artworkId = '';
  let listingId = '';

  function operatorToken(): string {
    return createDevToken(E2E_TOKEN_SECRET, {
      sub: `e2e-operator-${suffix}`,
      iss: E2E_ISSUER,
      aud: E2E_AUDIENCE,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
  }

  test('運営が作品を登録し、公開し、出品して、購入者が閲覧できる', async ({ request, page }) => {
    // --- 1. 初回アクセスで buyer として作られ、管理APIは拒否される -----------
    const denied = await request.get(`${apiBaseURL}/api/v1/admin/artworks`, {
      headers: { authorization: `Bearer ${operatorToken()}` },
    });
    expect(denied.status()).toBe(403);

    // --- 2. 運営へ昇格させる ------------------------------------------------
    // アプリに昇格APIを作っていないため（UD-803）、ここは運用と同じく DB 操作。
    // E2E からは直接 DB を触れないので、テスト用の昇格経路は使わず、
    // seed で用意した運営アカウントのトークンに切り替える。
    const seededOperator = createDevToken(E2E_TOKEN_SECRET, {
      sub: 'seed-operator',
      iss: E2E_ISSUER,
      aud: E2E_AUDIENCE,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const withSeeded = (path: string, body?: unknown) =>
      request.post(`${apiBaseURL}${path}`, {
        headers: { authorization: `Bearer ${seededOperator}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { data: body }),
      });

    // --- 3. 作品を登録する（下書き） ----------------------------------------
    const created = await withSeeded('/api/v1/admin/artworks', {
      slug,
      title: `E2E作品 ${suffix}`,
      description: '通しシナリオで登録した作品です。',
      maxSupply: 20,
    });
    expect(created.status()).toBe(201);
    const artwork = (await created.json()) as { id: string; status: string };
    artworkId = artwork.id;
    expect(artwork.status).toBe('draft');

    // 下書きの間は公開カタログに出ない。
    const beforePublish = await request.get(`${apiBaseURL}/api/v1/artworks/${slug}`);
    expect(beforePublish.status()).toBe(404);

    // --- 4. 画像を登録してから公開する --------------------------------------
    const png = Buffer.alloc(1024);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    const uploaded = await request.post(`${apiBaseURL}/api/v1/admin/artworks/${artworkId}/image`, {
      headers: { authorization: `Bearer ${seededOperator}`, 'content-type': 'image/png' },
      data: png,
    });
    expect(uploaded.status()).toBe(200);

    const published = await withSeeded(`/api/v1/admin/artworks/${artworkId}/publish`);
    expect(published.status()).toBe(200);

    // --- 5. 固定価格で出品し、販売を開始する --------------------------------
    const listingResponse = await withSeeded('/api/v1/admin/listings', {
      artworkId,
      priceAmount: 12000,
      priceCurrency: 'JPY',
    });
    expect(listingResponse.status()).toBe(201);
    const listing = (await listingResponse.json()) as { id: string };
    listingId = listing.id;

    const activated = await withSeeded(`/api/v1/admin/listings/${listingId}/activate`);
    expect(activated.status()).toBe(200);

    // --- 6. 購入者が一覧と詳細を見られる ------------------------------------
    await page.goto('/');
    await expect(page.getByText(`E2E作品 ${suffix}`)).toBeVisible();

    await page.goto(`/artworks/${slug}`);
    await expect(page.getByRole('heading', { name: `E2E作品 ${suffix}` })).toBeVisible();
    await expect(page.getByText('12,000')).toBeVisible();
    await expect(page.getByText('（税込）')).toBeVisible();

    // --- 7. 販売を終了すると購入可能表示が消える ----------------------------
    const ended = await withSeeded(`/api/v1/admin/listings/${listingId}/end`);
    expect(ended.status()).toBe(200);

    await page.goto(`/artworks/${slug}`);
    await expect(page.getByText('販売は終了しました')).toBeVisible();
    // お申し込みの案内は出ない。
    await expect(page.getByText('お申し込み機能は準備中です。')).toHaveCount(0);

    // --- 8. 作品を非公開にすると直接アクセスしても見えない ------------------
    const archived = await withSeeded(`/api/v1/admin/artworks/${artworkId}/archive`);
    expect(archived.status()).toBe(200);

    const afterArchive = await page.goto(`/artworks/${slug}`);
    expect(afterArchive?.status()).toBe(404);
  });

  test('非公開の作品は公開APIにも出ない', async ({ request }) => {
    const list = await request.get(`${apiBaseURL}/api/v1/artworks?limit=100`);
    const body = (await list.json()) as { items: { slug: string }[] };
    expect(body.items.map((item) => item.slug)).not.toContain(slug);
  });
});
