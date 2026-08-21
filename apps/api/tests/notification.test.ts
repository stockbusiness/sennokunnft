import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createDevToken, DevTokenVerifier, signWebhookPayload } from '@sengoku/integrations';
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
  TEST_WEBHOOK_SECRET,
  type TestHarness,
} from './helpers/doubles';

/**
 * 購入者への知らせ（実運営 指示書 P0-4）。
 *
 * ⚠️ **この組の主題は 5 つ。**
 *  1. 業務の出来事が、知らせとして 1 通だけ積まれること
 *  2. **同じ Webhook が 2 度届いても増えない**こと
 *  3. **知らせが積めなくても業務は止まらない**こと
 *  4. 文面と履歴に、正しい人しか届かないこと
 *  5. **宛先の平文がどこからも出ない**こと（`UD-503`）
 */
const LISTING_ID = '11111111-1111-4111-8111-111111111111';
const ORDER_TOTAL = 12000;

let harness: TestHarness;
let app: INestApplication;

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

function auth(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

function webhook(body: Record<string, unknown>) {
  const serialized = JSON.stringify(body);
  const rawBody = Buffer.from(serialized, 'utf8');
  const timestampSec = Math.floor(harness.clock.now().getTime() / 1000);
  const signature = signWebhookPayload(TEST_WEBHOOK_SECRET, timestampSec, rawBody);
  return request(app.getHttpServer())
    .post('/api/v1/webhooks/stripe')
    .set('stripe-signature', `t=${String(timestampSec)},v1=${signature}`)
    .set('content-type', 'application/json')
    .send(serialized);
}

async function placeOrder(): Promise<string> {
  harness.artworks.seed(sampleArtwork({ maxSupply: 3 }));
  harness.listings.seed(sampleListing({ id: LISTING_ID }));
  const buyer = actorToken('buyer');
  const created = await request(app.getHttpServer())
    .post('/api/v1/orders')
    .set(auth(buyer))
    .send({ listingId: LISTING_ID, idempotencyKey: randomUUID() })
    .expect(201);
  return created.body.order.id as string;
}

function notificationsFor(eventType: string): unknown[] {
  return harness.notifications.rows.filter((row) => row.record.eventType === eventType);
}

async function boot(): Promise<void> {
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
  await boot();
});

afterEach(async () => {
  await app.close();
});

describe('業務の出来事から知らせが積まれる', () => {
  it('注文を受け付けたら 1 通', async () => {
    await placeOrder();
    expect(notificationsFor('order.placed')).toHaveLength(1);
  });

  it('お支払いを確認したら 1 通', async () => {
    const orderId = await placeOrder();
    await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/checkout-session`)
      .set(auth(tokenFor('user-buyer')))
      .expect(201);
    await webhook({
      id: `evt_${randomUUID()}`,
      type: 'payment.succeeded',
      data: { order_id: orderId, amount: ORDER_TOTAL, currency: 'jpy' },
    }).expect(200);

    expect(notificationsFor('payment.succeeded')).toHaveLength(1);
  });

  it('★ 同じ Webhook が 2 度届いても 1 通のまま', async () => {
    const orderId = await placeOrder();
    await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/checkout-session`)
      .set(auth(tokenFor('user-buyer')))
      .expect(201);
    const event = {
      id: `evt_${randomUUID()}`,
      type: 'payment.succeeded',
      data: { order_id: orderId, amount: ORDER_TOTAL, currency: 'jpy' },
    };
    await webhook(event).expect(200);
    await webhook(event).expect(200);

    expect(notificationsFor('payment.succeeded')).toHaveLength(1);
  });

  it('お支払いが成立しなかったら 1 通', async () => {
    const orderId = await placeOrder();
    await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/checkout-session`)
      .set(auth(tokenFor('user-buyer')))
      .expect(201);
    await webhook({
      id: `evt_${randomUUID()}`,
      type: 'payment.failed',
      data: { order_id: orderId, failure_code: 'card_declined' },
    }).expect(200);

    expect(notificationsFor('payment.failed')).toHaveLength(1);
  });

  it('お支払いの期限が過ぎたら 1 通', async () => {
    const orderId = await placeOrder();
    await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/checkout-session`)
      .set(auth(tokenFor('user-buyer')))
      .expect(201);
    await webhook({
      id: `evt_${randomUUID()}`,
      type: 'checkout.expired',
      data: { order_id: orderId },
    }).expect(200);

    expect(notificationsFor('payment.expired')).toHaveLength(1);
  });

  it('★ 積まれた本文に宛先も金額以外の個人情報も入らない', async () => {
    await placeOrder();
    const body = JSON.stringify(harness.notifications.rows);
    expect(body).not.toContain('@');
  });

  it('★ 宛先の平文を持たない（送るまで解決しない）', async () => {
    await placeOrder();
    const row = harness.notifications.rows[0];
    expect(row?.maskedRecipient).toBeNull();
    expect(row?.recipientHash).toBeNull();
  });
});

describe('知らせが積めなくても業務は止まらない', () => {
  it('★ 文面が公開されていなくても注文はできる', async () => {
    harness.notificationTemplates.unpublish('order.placed');
    const orderId = await placeOrder();

    expect(orderId).toBeTruthy();
    expect(notificationsFor('order.placed')).toHaveLength(0);
  });

  it('★ 差し込む値が足りなくても注文はできる', async () => {
    // ⚠️ 語彙にはあるが値が渡らない語を混ぜる。
    harness.notificationTemplates.setBody(
      'order.placed',
      '件名 {{orderNumber}}',
      '{{orderNumber}} / {{collectionUrl}}',
    );
    const orderId = await placeOrder();

    expect(orderId).toBeTruthy();
    // 空欄のまま送らない。積まないほうを選ぶ。
    expect(notificationsFor('order.placed')).toHaveLength(0);
  });

  it('★ 生成フラグが無効なら 1 通も積まれない（注文はできる）', async () => {
    harness = buildHarness(
      new DevTokenVerifier({
        secret: TEST_TOKEN_SECRET,
        issuer: TEST_ISSUER,
        audience: TEST_AUDIENCE,
        now: () => TEST_NOW,
      }),
    );
    await app.close();
    harness = {
      ...harness,
      notification: { ...harness.notification, generationEnabled: false },
    } as TestHarness;
    await boot();

    const orderId = await placeOrder();
    expect(orderId).toBeTruthy();
    expect(harness.notifications.rows).toHaveLength(0);
  });
});

describe('文面と履歴の管理', () => {
  it('未認証では文面を読めない', async () => {
    await request(app.getHttpServer()).get('/api/v1/admin/notifications/templates').expect(401);
  });

  it('会員は文面を読めない', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/notifications/templates')
      .set(auth(actorToken('buyer', 'buyer-x')))
      .expect(403);
  });

  it('閲覧者は読めるが書けない', async () => {
    const auditor = actorToken('auditor');
    await request(app.getHttpServer())
      .get('/api/v1/admin/notifications/templates')
      .set(auth(auditor))
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/v1/admin/notifications/templates/order.placed/versions')
      .set(auth(auditor))
      .send({ subject: '件名 {{orderNumber}}', body: '本文 {{orderNumber}}' })
      .expect(403);
  });

  it('★ 差し込める語を画面へ返す（書きながら気づけるように）', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/notifications/templates')
      .set(auth(actorToken('operator')))
      .expect(200);

    expect(response.body.variables['payment.succeeded']).toContain('totalAmount');
    expect(response.body.variables['payment.succeeded']).toContain('siteName');
  });

  it('★ 語彙に無い語を書いた文面は保存できない', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/admin/notifications/templates/order.placed/versions')
      .set(auth(actorToken('operator')))
      .send({ subject: '件名', body: 'ようこそ {{buyerEmail}} 様' })
      .expect(400);
  });

  it('新しい版は既定で下書き（保存しただけで全員へ届かない）', async () => {
    const operator = actorToken('operator');
    const created = await request(app.getHttpServer())
      .post('/api/v1/admin/notifications/templates/order.placed/versions')
      .set(auth(operator))
      .send({ subject: '第 2 版 {{orderNumber}}', body: '本文 {{orderNumber}}' })
      .expect(201);

    const list = await request(app.getHttpServer())
      .get('/api/v1/admin/notifications/templates')
      .set(auth(operator))
      .expect(200);
    const version2 = list.body.items.find(
      (row: { eventType: string; version: number }) =>
        row.eventType === 'order.placed' && row.version === created.body.version,
    );
    expect(version2.status).toBe('draft');
  });

  it('★ 公開はオーナーの印が要る', async () => {
    const operator = actorToken('operator');
    const created = await request(app.getHttpServer())
      .post('/api/v1/admin/notifications/templates/order.placed/versions')
      .set(auth(operator))
      .send({ subject: '第 2 版 {{orderNumber}}', body: '本文 {{orderNumber}}' })
      .expect(201);

    // 運営スタッフでは公開できない。
    await request(app.getHttpServer())
      .post(
        `/api/v1/admin/notifications/templates/order.placed/versions/${String(created.body.version)}/publish`,
      )
      .set(auth(operator))
      .expect(403);
  });

  it('★ 送信履歴に宛先の平文も本文も出ない', async () => {
    await placeOrder();
    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/notifications/deliveries')
      .set(auth(actorToken('operator')))
      .expect(200);

    expect(response.body.items.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain('@');
    expect(serialized).not.toContain('renderedBody');
  });

  it('★ 送信中の知らせは送り直せない', async () => {
    await placeOrder();
    const id = harness.notifications.rows[0]!.record.id;
    await harness.notifications.claimBatch({ limit: 1, now: TEST_NOW });

    await request(app.getHttpServer())
      .post(`/api/v1/admin/notifications/deliveries/${id}/resend`)
      .set(auth(actorToken('operator')))
      .expect(409);
  });
});

describe('送信の口', () => {
  it('★ 送らない配備でも 0 件で応える（口ごと消さない）', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/internal/jobs/send-notifications')
      .set('x-internal-job-token', TEST_INTERNAL_JOB_TOKEN)
      .expect(200);

    expect(response.body).toEqual({
      pickedCount: 0,
      sentCount: 0,
      skippedCount: 0,
      failedCount: 0,
    });
  });

  it('合言葉が違えば通らない', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/internal/jobs/send-notifications')
      .set('x-internal-job-token', 'wrong')
      .expect(401);
  });
});
