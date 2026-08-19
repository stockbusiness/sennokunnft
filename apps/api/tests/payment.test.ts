import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { checkoutSessionResponseSchema } from '@sengoku/contracts';
import { createDevToken, DevTokenVerifier, signWebhookPayload } from '@sengoku/integrations';
import type { Role } from '@sengoku/auth';
import { AppModule } from '../src/app.module';
import { DomainErrorFilter } from '../src/common/domain-error.filter';
import {
  APPROVED_FEE_RATE_BPS,
  buildHarness,
  sampleArtwork,
  sampleListing,
  TEST_AUDIENCE,
  TEST_ISSUER,
  TEST_NOW,
  TEST_TOKEN_SECRET,
  TEST_WEBHOOK_SECRET,
  type TestHarness,
} from './helpers/doubles';

let app: INestApplication;
let harness: TestHarness;

const LISTING_ID = '11111111-1111-4111-8111-111111111111';
const ARTWORK_ID = 'artwork-1';

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

function seedPurchasable(maxSupply = 3): void {
  harness.artworks.seed(sampleArtwork({ maxSupply }));
  harness.listings.seed(sampleListing({ id: LISTING_ID }));
}

async function createOrder(token: string): Promise<{ id: string; total: number }> {
  const response = await request(app.getHttpServer())
    .post('/api/v1/orders')
    .set('Authorization', `Bearer ${token}`)
    .send({ listingId: LISTING_ID, idempotencyKey: randomUUID() })
    .expect(201);
  return { id: response.body.order.id as string, total: response.body.order.totalAmount as number };
}

function createCheckout(orderId: string, token: string) {
  return request(app.getHttpServer())
    .post(`/api/v1/orders/${orderId}/checkout-session`)
    .set('Authorization', `Bearer ${token}`);
}

/**
 * 擬似の決済事業者から届く知らせ。署名は本物と同じ手順で作る。
 *
 * ⚠️ **本文は文字列で送る。** supertest に `Buffer` を渡すと JSON へ
 * 包み直され、署名した中身と実際に届く中身がずれる。
 */
function webhook(body: Record<string, unknown>, options: { secret?: string } = {}) {
  const serialized = JSON.stringify(body);
  const rawBody = Buffer.from(serialized, 'utf8');
  const timestampSec = Math.floor(harness.clock.now().getTime() / 1000);
  const signature = signWebhookPayload(
    options.secret ?? TEST_WEBHOOK_SECRET,
    timestampSec,
    rawBody,
  );
  return request(app.getHttpServer())
    .post('/api/v1/webhooks/stripe')
    .set('stripe-signature', `t=${String(timestampSec)},v1=${signature}`)
    .set('content-type', 'application/json')
    .send(serialized);
}

function succeededEvent(orderId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `evt_${randomUUID()}`,
    type: 'payment.succeeded',
    data: { order_id: orderId, amount: 12000, currency: 'jpy', ...overrides },
  };
}

async function buildApp(): Promise<void> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.register(harness)],
  }).compile();
  app = moduleRef.createNestApplication({ rawBody: true });
  app.useGlobalFilters(new DomainErrorFilter());
  await app.init();
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
  await buildApp();
});

afterEach(async () => {
  await app.close();
});

describe('支払い口の作成 POST /api/v1/orders/:id/checkout-session', () => {
  it('注文者本人なら作れる', async () => {
    seedPurchasable();
    const token = actorToken('buyer');
    const order = await createOrder(token);

    const response = await createCheckout(order.id, token).expect(201);

    expect(checkoutSessionResponseSchema.safeParse(response.body).success).toBe(true);
    expect(response.body.reused).toBe(false);
  });

  it('他人の注文には作れない（404）', async () => {
    // ⚠️ 403 にしない。区別すると注文IDの総当たりで存在を確かめられる。
    seedPurchasable();
    const owner = actorToken('buyer', 'user-owner');
    const order = await createOrder(owner);
    const stranger = actorToken('buyer', 'user-stranger');

    await createCheckout(order.id, stranger).expect(404);
  });

  it('ログインしていなければ作れない', async () => {
    seedPurchasable();
    const token = actorToken('buyer');
    const order = await createOrder(token);

    await request(app.getHttpServer())
      .post(`/api/v1/orders/${order.id}/checkout-session`)
      .expect(401);
  });

  it('【12】手数料 20% で、配分は 80% になる', async () => {
    seedPurchasable();
    const token = actorToken('buyer');
    const order = await createOrder(token);

    const operator = actorToken('operator');
    const admin = await request(app.getHttpServer())
      .get(`/api/v1/admin/orders/${order.id}`)
      .set('Authorization', `Bearer ${operator}`)
      .expect(200);

    expect(admin.body.platformFeeRateBps).toBe(APPROVED_FEE_RATE_BPS);
    expect(admin.body.totalAmount).toBe(12000);
    expect(admin.body.platformFeeAmount).toBe(2400);
    expect(admin.body.creatorAmount).toBe(9600);
    // ⚠️ 足して合計になること。丸めの向きで崩れないことを見る。
    expect(admin.body.platformFeeAmount + admin.body.creatorAmount).toBe(admin.body.totalAmount);
  });

  it('【8】有効な支払い口があれば使い回す', async () => {
    // ⚠️ 押すたびに作ると、同じ注文の口が複数生き、両方で払える。
    seedPurchasable();
    const token = actorToken('buyer');
    const order = await createOrder(token);

    const first = await createCheckout(order.id, token).expect(201);
    const second = await createCheckout(order.id, token).expect(201);

    expect(first.body.reused).toBe(false);
    expect(second.body.reused).toBe(true);
    expect(second.body.checkoutUrl).toBe(first.body.checkoutUrl);
    // 決済の記録も 1 件だけ。
    expect(await harness.paymentRepository.listAttempts(order.id)).toHaveLength(1);
  });

  it('支払い済みの注文には作れない', async () => {
    seedPurchasable();
    const token = actorToken('buyer');
    const order = await createOrder(token);
    await createCheckout(order.id, token).expect(201);
    await webhook(succeededEvent(order.id)).expect(200);

    await createCheckout(order.id, token).expect(409);
  });

  it('【10】お取り置きの期限が切れていたら作れない', async () => {
    seedPurchasable();
    const token = actorToken('buyer');
    const order = await createOrder(token);
    harness.clock.advanceMs(31 * 60 * 1000);

    const response = await createCheckout(order.id, token).expect(410);
    expect(response.body.error.code).toBe('RESERVATION_EXPIRED');
  });
});

describe('【13】手数料が未設定なら支払い口を作らせない', () => {
  beforeEach(async () => {
    await app.close();
    harness = buildHarness(
      new DevTokenVerifier({
        secret: TEST_TOKEN_SECRET,
        issuer: TEST_ISSUER,
        audience: TEST_AUDIENCE,
        now: () => TEST_NOW,
      }),
    );
    // ⚠️ 0 は「無料」ではなく「販売設定未完了」（UD-109）。
    (harness.orders as { platformFeeRateBps: number }).platformFeeRateBps = 0;
    await buildApp();
  });

  it('0 のときは 409 を返し、内部の設定値を見せない', async () => {
    seedPurchasable();
    const token = actorToken('buyer');
    const order = await createOrder(token);

    const response = await createCheckout(order.id, token).expect(409);

    expect(response.body.error.code).toBe('SALES_SETUP_INCOMPLETE');
    // ⚠️ 「手数料が未設定です」と言わない。買う人にできることが無い。
    expect(response.body.error.message).toContain('購入準備');
    expect(JSON.stringify(response.body)).not.toContain('PLATFORM_FEE');
    expect(JSON.stringify(response.body)).not.toContain('手数料');
  });
});

describe('Webhook の署名検証 POST /api/v1/webhooks/stripe', () => {
  it('正しい署名は受理する', async () => {
    seedPurchasable();
    const token = actorToken('buyer');
    const order = await createOrder(token);
    await createCheckout(order.id, token).expect(201);

    await webhook(succeededEvent(order.id)).expect(200);
  });

  it('署名が無ければ拒否する', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/webhooks/stripe')
      .set('content-type', 'application/json')
      .send(JSON.stringify(succeededEvent('order-x')))
      .expect(400);
  });

  it('署名が不正なら拒否する', async () => {
    await webhook(succeededEvent('order-x'), { secret: 'wrong-secret' }).expect(400);
  });

  it('本文を書き換えた後の署名を拒否する', async () => {
    // ⚠️ 生のバイト列で検証している証拠。組み直した JSON では通らない。
    seedPurchasable();
    const token = actorToken('buyer');
    const order = await createOrder(token);
    const body = succeededEvent(order.id);
    const rawBody = Buffer.from(JSON.stringify(body), 'utf8');
    const timestampSec = Math.floor(harness.clock.now().getTime() / 1000);
    const signature = signWebhookPayload(TEST_WEBHOOK_SECRET, timestampSec, rawBody);

    await request(app.getHttpServer())
      .post('/api/v1/webhooks/stripe')
      .set('stripe-signature', `t=${String(timestampSec)},v1=${signature}`)
      .set('content-type', 'application/json')
      // 金額だけ書き換える。
      .send(JSON.stringify({ ...body, data: { ...body.data, amount: 1 } }))
      .expect(400);
  });

  it('知らないイベントは 200 で受け取り、注文を進めない', async () => {
    // ⚠️ 拒否すると事業者が再送し続け、いずれ宛先ごと無効化される。
    seedPurchasable();
    const token = actorToken('buyer');
    const order = await createOrder(token);

    await webhook({ id: `evt_${randomUUID()}`, type: 'charge.updated' }).expect(200);

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/orders/${order.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(detail.body.status).toBe('pending');
  });
});

describe('決済成功の確定', () => {
  async function paidOrder(): Promise<{ id: string; token: string }> {
    seedPurchasable();
    const token = actorToken('buyer');
    const order = await createOrder(token);
    await createCheckout(order.id, token).expect(201);
    await webhook(succeededEvent(order.id)).expect(200);
    return { id: order.id, token };
  }

  it('注文と決済が成功状態になる', async () => {
    const { id, token } = await paidOrder();

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/orders/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(detail.body.status).toBe('paid');
    expect(detail.body.paymentStatus).toBe('succeeded');
  });

  it('【1】決済成功では issuedCount を増やさない', async () => {
    // ⚠️ 決定 A。受取権を作っていないのに増やすと、シリアル番号がずれる。
    await paidOrder();
    const artwork = await harness.artworks.findById(ARTWORK_ID);
    expect(artwork?.issuedCount).toBe(0);
  });

  it('【2】決済成功では reservedCount を減らさない', async () => {
    /*
      ⚠️ 決定 A。減らすと、受取権を作る前のわずかな間だけ販売枠が復活し、
         その隙に他の人が買うと、売れた注文の発行が上限で弾かれる。
    */
    await paidOrder();
    const artwork = await harness.artworks.findById(ARTWORK_ID);
    expect(artwork?.reservedCount).toBe(1);
  });

  it('【3】予約だけが consumed になる', async () => {
    const { id } = await paidOrder();
    const operator = actorToken('operator');
    const admin = await request(app.getHttpServer())
      .get(`/api/v1/admin/orders/${id}`)
      .set('Authorization', `Bearer ${operator}`)
      .expect(200);

    expect(admin.body.reservation.status).toBe('consumed');
  });

  it('【4】consumed の枠は新しい購入へ回らない', async () => {
    // 在庫 1 の作品を買い、決済まで済ませる。次の人は買えない。
    harness.artworks.seed(sampleArtwork({ maxSupply: 1 }));
    harness.listings.seed(sampleListing({ id: LISTING_ID }));
    const buyer = actorToken('buyer', 'user-first');
    const order = await createOrder(buyer);
    await createCheckout(order.id, buyer).expect(201);
    await webhook(succeededEvent(order.id)).expect(200);

    const second = actorToken('buyer', 'user-second');
    await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${second}`)
      .send({ listingId: LISTING_ID, idempotencyKey: randomUUID() })
      .expect(409);
  });

  it('【6】同じ知らせを再送してもカウンタも記録も増えない', async () => {
    seedPurchasable();
    const token = actorToken('buyer');
    const order = await createOrder(token);
    await createCheckout(order.id, token).expect(201);
    const event = succeededEvent(order.id);

    await webhook(event).expect(200);
    await webhook(event).expect(200);
    await webhook(event).expect(200);

    const artwork = await harness.artworks.findById(ARTWORK_ID);
    expect(artwork?.reservedCount).toBe(1);
    expect(artwork?.issuedCount).toBe(0);
    // ⚠️ 次の工程へ渡す出来事は 1 件だけ。
    expect(harness.paymentRepository.outbox).toHaveLength(1);
  });

  it('別のイベントIDでも、同じ支払いなら 1 回しか確定しない', async () => {
    // ⚠️ Stripe は 1 回の支払いについて複数のイベントを送る。
    seedPurchasable();
    const token = actorToken('buyer');
    const order = await createOrder(token);
    await createCheckout(order.id, token).expect(201);

    await webhook(succeededEvent(order.id)).expect(200);
    await webhook(succeededEvent(order.id)).expect(200);

    expect(harness.paymentRepository.outbox).toHaveLength(1);
  });

  it('金額が違えば確定しない', async () => {
    // ⚠️ ここが抜けると、少ない入金で商品を渡すことになる。
    seedPurchasable();
    const token = actorToken('buyer');
    const order = await createOrder(token);
    await createCheckout(order.id, token).expect(201);

    await webhook(succeededEvent(order.id, { amount: 1 })).expect(200);

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/orders/${order.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(detail.body.status).not.toBe('paid');
    expect(harness.paymentRepository.outbox).toHaveLength(0);
  });

  it('通貨が違えば確定しない', async () => {
    seedPurchasable();
    const token = actorToken('buyer');
    const order = await createOrder(token);
    await createCheckout(order.id, token).expect(201);

    await webhook(succeededEvent(order.id, { currency: 'usd' })).expect(200);

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/orders/${order.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(detail.body.status).not.toBe('paid');
  });

  it('注文IDが不明なら確定しない', async () => {
    seedPurchasable();
    const token = actorToken('buyer');
    const order = await createOrder(token);
    await createCheckout(order.id, token).expect(201);

    await webhook(succeededEvent(randomUUID())).expect(200);

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/orders/${order.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(detail.body.status).not.toBe('paid');
  });

  it('ブラウザの戻りでは paid にならない', async () => {
    // ⚠️ 指示書 §4-3。戻りは誰でも作れる。Webhook を送らずに確かめる。
    seedPurchasable();
    const token = actorToken('buyer');
    const order = await createOrder(token);
    await createCheckout(order.id, token).expect(201);

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/orders/${order.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(detail.body.status).toBe('checkout_created');
    expect(detail.body.paymentStatus).toBe('pending');
  });
});

describe('決済失敗と再試行（決定B）', () => {
  it('【7】失敗しても、期限内なら新しい支払い口を作れる', async () => {
    seedPurchasable();
    const token = actorToken('buyer');
    const order = await createOrder(token);
    const first = await createCheckout(order.id, token).expect(201);

    await webhook({
      id: `evt_${randomUUID()}`,
      type: 'payment.failed',
      data: { order_id: order.id, failure_code: 'card_declined' },
    }).expect(200);

    // ⚠️ 注文は checkout_created のまま。pending へ戻さない。
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/orders/${order.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(detail.body.status).toBe('checkout_created');
    expect(detail.body.paymentStatus).toBe('failed');

    // 【9】終わった口なので、新しい口が作られる。
    const retry = await createCheckout(order.id, token).expect(201);
    expect(retry.body.reused).toBe(false);
    expect(retry.body.checkoutUrl).not.toBe(first.body.checkoutUrl);
    // 試行の履歴は消さない。
    expect(await harness.paymentRepository.listAttempts(order.id)).toHaveLength(2);
  });

  it('失敗しても在庫は押さえたまま', async () => {
    seedPurchasable();
    const token = actorToken('buyer');
    const order = await createOrder(token);
    await createCheckout(order.id, token).expect(201);

    await webhook({
      id: `evt_${randomUUID()}`,
      type: 'payment.failed',
      data: { order_id: order.id, failure_code: 'card_declined' },
    }).expect(200);

    const artwork = await harness.artworks.findById(ARTWORK_ID);
    expect(artwork?.reservedCount).toBe(1);
  });
});

describe('支払い口の期限切れ', () => {
  it('注文を期限切れにし、在庫を戻す', async () => {
    seedPurchasable();
    const token = actorToken('buyer');
    const order = await createOrder(token);
    await createCheckout(order.id, token).expect(201);

    await webhook({
      id: `evt_${randomUUID()}`,
      type: 'checkout.expired',
      data: { order_id: order.id },
    }).expect(200);

    const artwork = await harness.artworks.findById(ARTWORK_ID);
    expect(artwork?.reservedCount).toBe(0);
  });

  it('既存の解放ジョブと二重に解放しない', async () => {
    /*
      ⚠️ 指示書 §8。どちらが先に動いても在庫は 1 回しか戻らない。
         二重に戻ると、在庫が実際より多く見え、売れない物が売れる。
    */
    seedPurchasable();
    const token = actorToken('buyer');
    const order = await createOrder(token);
    await createCheckout(order.id, token).expect(201);
    harness.clock.advanceMs(31 * 60 * 1000);

    // 先に解放ジョブが動く。
    await request(app.getHttpServer())
      .post('/api/v1/internal/jobs/release-expired-reservations')
      .set('x-internal-job-token', 'test-internal-job-token-0123456789abcdef')
      .expect(200);

    // あとから期限切れの知らせが届く。
    await webhook({
      id: `evt_${randomUUID()}`,
      type: 'checkout.expired',
      data: { order_id: order.id },
    }).expect(200);

    const artwork = await harness.artworks.findById(ARTWORK_ID);
    expect(artwork?.reservedCount).toBe(0);
  });
});
