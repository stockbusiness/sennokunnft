import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { createDevToken } from '@sengoku/integrations';
import { createHmac } from 'node:crypto';
import {
  apiBaseURL,
  WEB_PORT,
  E2E_AUDIENCE,
  E2E_ISSUER,
  E2E_TOKEN_SECRET,
  E2E_WEBHOOK_SECRET,
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

  /**
   * 特商法表記を公開しておく。
   *
   * ⚠️ **これが無いと購入手続きへ進めない**（特商法12条の6）。掲げるものが
   * 無ければ確認画面も支払い口も断られる。本番と同じ経路（管理API）で公開する。
   *
   * ⚠️ 中身は試験用の文字列。実際の文面は `UD-111` の法務確認を経て、
   * 管理画面から入力する。
   */
  async function ensureTokushohoPublished(
    request: APIRequestContext,
    operatorToken: string,
    page: Page,
  ): Promise<void> {
    const headers = {
      authorization: `Bearer ${operatorToken}`,
      'content-type': 'application/json',
    };
    const draft = await request.put(`${apiBaseURL}/api/v1/admin/legal/tokushoho/draft`, {
      headers,
      data: {
        title: '特定商取引法に基づく表記',
        tokushoho: {
          sellerName: 'E2E事業者',
          representativeName: 'E2E 太郎',
          address: '東京都千代田区1-1-1',
          phoneNumber: '03-0000-0000',
          contactEmail: 'e2e@example.com',
          priceDescription: '各作品ページに表示された金額（税込）',
          additionalFees: 'なし',
          paymentMethods: 'クレジットカード',
          paymentTiming: 'お申し込み時',
          deliveryTiming: 'お支払い確認後すみやかに',
          returnPolicy: 'デジタル商品のため、お客様都合による返品はお受けできません。',
          operatingEnvironment: '一般的なウェブブラウザ',
        },
      },
    });
    expect(draft.status()).toBe(200);

    const published = await request.post(`${apiBaseURL}/api/v1/admin/legal/tokushoho/publish`, {
      headers,
      // ⚠️ 過去の日付では公開できない。少し先を指定して、すぐにまたぐ。
      data: { effectiveFrom: new Date(Date.now() + 1000).toISOString() },
    });
    expect(published.status()).toBe(201);
    // ⚠️ 施行日が来るまで待つ。「公開済み＝いま有効」ではない。
    await page.waitForTimeout(1500);
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

    await ensureTokushohoPublished(request, operator, page);

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

    /*
      ⚠️ **お申し込みの条件が確認画面に出ていること**（特商法12条の6）。
         とくに返品特約は、ここに出していないとこちらの条件が効かず、
         法定の解除権が適用される。リンクだけでは要件を満たさない。
    */
    await expect(page.getByRole('heading', { name: 'お申し込みの条件' })).toBeVisible();
    await expect(page.getByText('返品・キャンセルについて')).toBeVisible();
    await expect(
      page.getByText('デジタル商品のため、お客様都合による返品はお受けできません。'),
    ).toBeVisible();

    // --- 4. 申し込むと「決済準備中」へ進む ----------------------------------
    await Promise.all([
      page.waitForURL(/\/orders\//),
      page.getByRole('button', { name: 'この内容で申し込む' }).click(),
    ]);
    await expect(page.getByRole('heading', { name: 'お申し込みを承りました' })).toBeVisible();
    // 決済 Phase P2: ここから「お支払いへ進む」へ続く。
    await expect(page.getByRole('button', { name: 'お支払いへ進む' })).toBeVisible();
    /*
      ⚠️ **決済会社からの通知を受ける前に「完了」と読める言葉を置かない**
         （指示書 §12）。ブラウザがここへ来ただけでは、払えていない。
    */
    await expect(page.getByText('お支払いが完了しました')).toHaveCount(0);
    await expect(page.getByText('ご購入ありがとうございます')).toHaveCount(0);
    // ⚠️ この時点ではまだ自サイト内。
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
    // ✅ 手数料 20%（承認済み）。12,000 円の 80% が出品者の取り分。
    expect(mine?.creatorAmount).toBe(9600);
  });

  /**
   * 決済の確定までを通す（決済 Phase P2）。
   *
   * ⚠️ **Stripe へは繋がない。** 擬似の決済事業者を使う。署名の作り方と
   * 検証の手順は本物と同じなので、「署名が正しい通知だけが注文を進める」
   * ことをここで確かめられる。実 Stripe の通し試験は別途。
   */
  test('署名のある通知だけが注文を支払い済みにする', async ({ request, page, context }) => {
    const operator = tokenFor('seed-operator');
    const post = (path: string, body?: unknown) =>
      request.post(`${apiBaseURL}${path}`, {
        headers: { authorization: `Bearer ${operator}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { data: body }),
      });

    // --- 1. 売れる作品を用意する --------------------------------------------
    const paySlug = `e2e-pay-${suffix}`;
    const created = await post('/api/v1/admin/artworks', {
      slug: paySlug,
      title: `E2E決済 ${suffix}`,
      description: '決済の通しシナリオで使う作品です。',
      maxSupply: 2,
    });
    expect(created.status()).toBe(201);
    const artwork = (await created.json()) as { id: string };

    const png = Buffer.alloc(1024);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    await request.post(`${apiBaseURL}/api/v1/admin/artworks/${artwork.id}/image`, {
      headers: { authorization: `Bearer ${operator}`, 'content-type': 'image/png' },
      data: png,
    });
    await post(`/api/v1/admin/artworks/${artwork.id}/publish`);
    const listingResponse = await post('/api/v1/admin/listings', {
      artworkId: artwork.id,
      priceAmount: 12000,
      priceCurrency: 'JPY',
    });
    const listing = (await listingResponse.json()) as { id: string };
    await post(`/api/v1/admin/listings/${listing.id}/activate`);

    await ensureTokushohoPublished(request, operator, page);

    // --- 2. 購入者が申し込む ------------------------------------------------
    const buyer = `e2e-payer-${suffix}`;
    await context.addCookies([
      { name: 'sengoku_at', value: tokenFor(buyer), domain: '127.0.0.1', path: '/' },
      {
        name: 'sengoku_at_exp',
        value: String(Math.floor(Date.now() / 1000) + 3600),
        domain: '127.0.0.1',
        path: '/',
      },
    ]);
    await page.goto(`/checkout/${listing.id}`);
    await Promise.all([
      page.waitForURL(/\/orders\//),
      page.getByRole('button', { name: 'この内容で申し込む' }).click(),
    ]);
    const orderId = new URL(page.url()).pathname.split('/').pop() ?? '';
    expect(orderId).not.toBe('');

    // --- 3. 支払い口を作る（外部へは飛ばさず、API を直接呼ぶ）--------------
    const buyerToken = tokenFor(buyer);
    const session = await request.post(`${apiBaseURL}/api/v1/orders/${orderId}/checkout-session`, {
      headers: { authorization: `Bearer ${buyerToken}` },
    });
    expect(session.status()).toBe(201);
    const sessionBody = (await session.json()) as { checkoutUrl: string; reused: boolean };
    expect(sessionBody.reused).toBe(false);

    // ⚠️ もう一度押しても、同じ口を使い回す。
    const again = await request.post(`${apiBaseURL}/api/v1/orders/${orderId}/checkout-session`, {
      headers: { authorization: `Bearer ${buyerToken}` },
    });
    expect(((await again.json()) as { reused: boolean }).reused).toBe(true);

    // --- 4. 署名の無い通知では確定しない ------------------------------------
    const unsigned = await request.post(`${apiBaseURL}/api/v1/webhooks/stripe`, {
      headers: { 'content-type': 'application/json' },
      data: { id: 'evt_forged', type: 'payment.succeeded', data: { order_id: orderId } },
    });
    expect(unsigned.status()).toBe(400);

    // ⚠️ ブラウザで戻ってきただけでも確定しない。
    await page.goto(`/account/orders/${orderId}`);
    await expect(page.getByText('ご購入ありがとうございます')).toHaveCount(0);

    // --- 5. 署名のある通知で確定する ----------------------------------------
    const payload = JSON.stringify({
      id: `evt_${suffix}`,
      type: 'payment.succeeded',
      data: { order_id: orderId, amount: 12000, currency: 'jpy' },
    });
    const timestampSec = Math.floor(Date.now() / 1000);
    const signature = createHmac('sha256', E2E_WEBHOOK_SECRET)
      .update(`${String(timestampSec)}.`)
      .update(Buffer.from(payload, 'utf8'))
      .digest('hex');

    const accepted = await request.post(`${apiBaseURL}/api/v1/webhooks/stripe`, {
      headers: {
        'content-type': 'application/json',
        'stripe-signature': `t=${String(timestampSec)},v1=${signature}`,
      },
      data: payload,
    });
    expect(accepted.status()).toBe(200);

    // --- 6. 画面が「作品を準備しています」に変わる --------------------------
    await page.goto(`/account/orders/${orderId}`);
    await expect(page.getByRole('heading', { name: 'ご購入ありがとうございます' })).toBeVisible();
    // ⚠️ 受取権はまだ発行していない（Phase P3）。
    await expect(page.getByText('受け取りました')).toHaveCount(0);

    // --- 7. 在庫のカウンタは動いていない（決定 A）--------------------------
    /*
      ⚠️ 決済が済んでも枠は reserved 側で押さえ続ける。
         公開APIから見える残数は、申し込んだ時点から変わらない。
    */
    const detail = await request.get(`${apiBaseURL}/api/v1/artworks/${paySlug}`);
    const body = (await detail.json()) as { availableSupply: number; maxSupply: number };
    expect(body.maxSupply).toBe(2);
    expect(body.availableSupply).toBe(1);
  });
});
