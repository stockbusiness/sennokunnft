import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { adminOrderViewSchema, orderViewSchema } from '@sengoku/contracts';
import { createDevToken, DevTokenVerifier } from '@sengoku/integrations';
import type { Role } from '@sengoku/auth';
import { AppModule } from '../src/app.module';
import { DomainErrorFilter } from '../src/common/domain-error.filter';
import {
  buildHarness,
  sampleArtwork,
  sampleListing,
  TEST_AUDIENCE,
  TEST_INTERNAL_JOB_TOKEN,
  TEST_ISSUER,
  TEST_NOW,
  TEST_TOKEN_SECRET,
  type TestHarness,
} from './helpers/doubles';

let app: INestApplication;
let harness: TestHarness;

const LISTING_ID = '11111111-1111-4111-8111-111111111111';

function tokenFor(subject: string): string {
  return createDevToken(TEST_TOKEN_SECRET, {
    sub: subject,
    iss: TEST_ISSUER,
    aud: TEST_AUDIENCE,
    exp: Math.floor(TEST_NOW.getTime() / 1000) + 3600,
  });
}

function actorToken(role: Role, subject = `user-${role}`): string {
  harness.accounts.seed(subject, role);
  return tokenFor(subject);
}

/** 買える状態の作品と出品を 1 組そろえる。 */
function seedPurchasable(overrides: { maxSupply?: number } = {}): void {
  harness.artworks.seed(sampleArtwork({ maxSupply: overrides.maxSupply ?? 3 }));
  harness.listings.seed(sampleListing({ id: LISTING_ID }));
}

beforeEach(async () => {
  harness = buildHarness(
    new DevTokenVerifier({
      secret: TEST_TOKEN_SECRET,
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
      now: () => TEST_NOW,
    }),
  );
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.register(harness)],
  }).compile();
  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new DomainErrorFilter());
  await app.init();
});

afterEach(async () => {
  await app.close();
});

describe('注文作成 POST /api/v1/orders', () => {
  it('注文と在庫の仮引当を作る', async () => {
    seedPurchasable();
    const token = actorToken('buyer');

    const response = await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ listingId: LISTING_ID, idempotencyKey: randomUUID() })
      .expect(201);

    expect(orderViewSchema.safeParse(response.body.order).success).toBe(true);
    expect(response.body.reused).toBe(false);
    // 在庫は「押さえた」ぶんだけ減る。減らないと、同じ枠が何度でも売れる。
    const artwork = await harness.artworks.findById('artwork-1');
    expect(artwork?.reservedCount).toBe(1);
  });

  it('価格・通貨・出品者をサーバー側で決める', async () => {
    // ⚠️ 指示書 §4.2。本文に金額を混ぜても、応答は出品の価格になる。
    seedPurchasable();
    const token = actorToken('buyer');

    const response = await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({
        listingId: LISTING_ID,
        idempotencyKey: randomUUID(),
        totalAmount: 1,
        currency: 'USD',
        creatorId: 'someone-else',
      })
      .expect(201);

    expect(response.body.order.totalAmount).toBe(12000);
    expect(response.body.order.currency).toBe('JPY');
  });

  it('手数料とクリエイター配分を購入者へ返さない', async () => {
    seedPurchasable();
    const token = actorToken('buyer');

    const response = await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ listingId: LISTING_ID, idempotencyKey: randomUUID() })
      .expect(201);

    expect(response.body.order).not.toHaveProperty('platformFeeAmount');
    expect(response.body.order).not.toHaveProperty('creatorAmount');
  });

  it('ログインしていなければ作れない', async () => {
    seedPurchasable();
    await request(app.getHttpServer())
      .post('/api/v1/orders')
      .send({ listingId: LISTING_ID, idempotencyKey: randomUUID() })
      .expect(401);
  });

  it('販売していない出品では作れない', async () => {
    harness.artworks.seed(sampleArtwork());
    harness.listings.seed(sampleListing({ id: LISTING_ID, status: 'draft' }));
    const token = actorToken('buyer');

    await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ listingId: LISTING_ID, idempotencyKey: randomUUID() })
      .expect(409);
  });

  it('存在しない出品では作れない', async () => {
    const token = actorToken('buyer');
    await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ listingId: randomUUID(), idempotencyKey: randomUUID() })
      .expect(404);
  });

  it('在庫が尽きたら作れない', async () => {
    seedPurchasable({ maxSupply: 1 });
    const token = actorToken('buyer');

    await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ listingId: LISTING_ID, idempotencyKey: randomUUID() })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ listingId: LISTING_ID, idempotencyKey: randomUUID() })
      .expect(409);
  });
});

describe('注文作成の冪等性（指示書 §4.5）', () => {
  it('同じキー・同じ商品なら、最初の注文をそのまま返す', async () => {
    seedPurchasable();
    const token = actorToken('buyer');
    const key = randomUUID();

    const first = await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ listingId: LISTING_ID, idempotencyKey: key })
      .expect(201);
    const second = await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ listingId: LISTING_ID, idempotencyKey: key })
      .expect(201);

    expect(second.body.order.id).toBe(first.body.order.id);
    expect(second.body.reused).toBe(true);
    // ⚠️ 在庫は 1 つしか減らない。ここが 2 になると、押さえが二重になる。
    const artwork = await harness.artworks.findById('artwork-1');
    expect(artwork?.reservedCount).toBe(1);
  });

  it('同じキーで違う商品なら 409 を返す', async () => {
    // ⚠️ 前の注文を返さない。返すと、買ったつもりのない物を買わされる。
    seedPurchasable();
    const otherListingId = '22222222-2222-4222-8222-222222222222';
    harness.artworks.seed(sampleArtwork({ id: 'artwork-2', slug: 'other', maxSupply: 3 }));
    harness.listings.seed(
      sampleListing({
        id: otherListingId,
        artworkId: 'artwork-2',
        price: { amountMinor: 9000, currency: 'JPY' },
      }),
    );
    const token = actorToken('buyer');
    const key = randomUUID();

    await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ listingId: LISTING_ID, idempotencyKey: key })
      .expect(201);

    const conflict = await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ listingId: otherListingId, idempotencyKey: key })
      .expect(409);

    expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('冪等キーの全体を監査ログへ残さない', async () => {
    seedPurchasable();
    const token = actorToken('buyer');
    const key = randomUUID();

    await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ listingId: LISTING_ID, idempotencyKey: key })
      .expect(201);

    const entries = harness.audit.entries.filter((entry) => entry.action === 'order.created');
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries[0]?.summary)).not.toContain(key);
  });
});

describe('注文の閲覧 GET /api/v1/orders/:id', () => {
  async function createOrder(token: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ listingId: LISTING_ID, idempotencyKey: randomUUID() })
      .expect(201);
    return response.body.order.id as string;
  }

  it('自分の注文は見られる', async () => {
    seedPurchasable();
    const token = actorToken('buyer');
    const orderId = await createOrder(token);

    const response = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(orderViewSchema.safeParse(response.body).success).toBe(true);
  });

  it('他人の注文は 404 にする', async () => {
    // ⚠️ 403 にしない。分けると、注文IDの総当たりで存在を確かめられる。
    seedPurchasable();
    const owner = actorToken('buyer', 'user-owner');
    const orderId = await createOrder(owner);
    const stranger = actorToken('buyer', 'user-stranger');

    await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${stranger}`)
      .expect(404);
  });
});

describe('運営の注文一覧 GET /api/v1/admin/orders', () => {
  it('運営は内訳まで見られる', async () => {
    seedPurchasable();
    const buyer = actorToken('buyer');
    await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${buyer}`)
      .send({ listingId: LISTING_ID, idempotencyKey: randomUUID() })
      .expect(201);

    const operator = actorToken('operator');
    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/orders')
      .set('Authorization', `Bearer ${operator}`)
      .expect(200);

    expect(response.body.items).toHaveLength(1);
    expect(adminOrderViewSchema.safeParse(response.body.items[0]).success).toBe(true);
  });

  it('購入者は運営の一覧を開けない', async () => {
    const buyer = actorToken('buyer');
    await request(app.getHttpServer())
      .get('/api/v1/admin/orders')
      .set('Authorization', `Bearer ${buyer}`)
      .expect(403);
  });

  it('冪等キーの全体を運営へも返さない', async () => {
    seedPurchasable();
    const buyer = actorToken('buyer');
    const key = randomUUID();
    await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${buyer}`)
      .send({ listingId: LISTING_ID, idempotencyKey: key })
      .expect(201);

    const operator = actorToken('operator');
    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/orders')
      .set('Authorization', `Bearer ${operator}`)
      .expect(200);

    expect(response.body.items[0].idempotencyKeyPrefix).not.toBe(key);
    expect(key.startsWith(response.body.items[0].idempotencyKeyPrefix)).toBe(true);
  });
});

describe('期限切れ予約の解放 POST /api/v1/internal/jobs/release-expired-reservations', () => {
  const path = '/api/v1/internal/jobs/release-expired-reservations';

  async function createExpiringOrder(): Promise<void> {
    seedPurchasable();
    const token = actorToken('buyer');
    await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ listingId: LISTING_ID, idempotencyKey: randomUUID() })
      .expect(201);
  }

  it('合言葉が無ければ 401 にする', async () => {
    await request(app.getHttpServer()).post(path).expect(401);
  });

  it('合言葉が違えば 401 にする', async () => {
    await request(app.getHttpServer())
      .post(path)
      .set('x-internal-job-token', 'wrong-token-wrong-token-wrong-tok')
      .expect(401);
  });

  it('期限内の予約は解放しない', async () => {
    await createExpiringOrder();

    const response = await request(app.getHttpServer())
      .post(path)
      .set('x-internal-job-token', TEST_INTERNAL_JOB_TOKEN)
      .expect(200);

    expect(response.body.releasedCount).toBe(0);
    const artwork = await harness.artworks.findById('artwork-1');
    expect(artwork?.reservedCount).toBe(1);
  });

  it('期限が過ぎた予約を解放し、在庫を戻す', async () => {
    await createExpiringOrder();
    // 30 分の取り置きを過ぎた時刻へ進める。
    harness.clock.advanceMs(31 * 60 * 1000);

    const response = await request(app.getHttpServer())
      .post(path)
      .set('x-internal-job-token', TEST_INTERNAL_JOB_TOKEN)
      .expect(200);

    expect(response.body.releasedCount).toBe(1);
    const artwork = await harness.artworks.findById('artwork-1');
    expect(artwork?.reservedCount).toBe(0);
  });

  it('もう一度走らせても二重に解放しない', async () => {
    // ⚠️ これが崩れると、在庫が実際より多く見える。
    await createExpiringOrder();
    harness.clock.advanceMs(31 * 60 * 1000);

    await request(app.getHttpServer())
      .post(path)
      .set('x-internal-job-token', TEST_INTERNAL_JOB_TOKEN)
      .expect(200);
    const second = await request(app.getHttpServer())
      .post(path)
      .set('x-internal-job-token', TEST_INTERNAL_JOB_TOKEN)
      .expect(200);

    expect(second.body.releasedCount).toBe(0);
    const artwork = await harness.artworks.findById('artwork-1');
    expect(artwork?.reservedCount).toBe(0);
  });
});

/**
 * 注文へ残す規約の版（`UD-126` 決定 2026-08-19）。
 *
 * ⚠️ **同意の記録ではない。** 「そのご注文の時点で、どう書いてあったか」の
 * 記録で、価格・手数料率と同じスナップショット原則。
 */
describe('注文時点の規約の版', () => {
  it('規約が未公開でも注文できる（null のまま残す）', async () => {
    // ⚠️ ここで止めると、規約を公開する前に手元で試せなくなる。
    seedPurchasable();
    const response = await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${actorToken('buyer')}`)
      .send({ listingId: LISTING_ID, idempotencyKey: randomUUID() })
      .expect(201);

    expect(harness.orderRepository.termsSnapshots.get(response.body.order.id)).toEqual({
      termsVersionId: null,
      termsVersion: null,
    });
  });

  it('施行中の版があれば、その版を注文へ写す', async () => {
    seedPurchasable();
    harness.legalRepository.seed({
      id: 'terms-v3',
      kind: 'terms',
      version: 3,
      status: 'published',
      title: '利用規約',
      bodyText: '本文',
      tokushoho: null,
      effectiveFrom: new Date(TEST_NOW.getTime() - 1000),
      requiresReconsent: false,
      publishedAt: new Date(TEST_NOW.getTime() - 1000),
      createdByAccountId: 'account-owner',
      publishedByAccountId: 'account-owner',
      createdAt: TEST_NOW,
    });

    const response = await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${actorToken('buyer')}`)
      .send({ listingId: LISTING_ID, idempotencyKey: randomUUID() })
      .expect(201);

    expect(harness.orderRepository.termsSnapshots.get(response.body.order.id)).toEqual({
      termsVersionId: 'terms-v3',
      termsVersion: 3,
    });
  });
});
