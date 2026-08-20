import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createDevToken, DevTokenVerifier, signWebhookPayload } from '@sengoku/integrations';
import { revocationEventId } from '@sengoku/domain';
import type { Role } from '@sengoku/auth';
import type { Logger } from '@sengoku/observability';
import { AppModule } from '../src/app.module';
import { DomainErrorFilter } from '../src/common/domain-error.filter';
import {
  buildHarness,
  InMemoryRevocationReconcile,
  InMemoryWalletDeliveryOutbox,
  sampleArtwork,
  sampleListing,
  TEST_AUDIENCE,
  TEST_ISSUER,
  TEST_NOW,
  TEST_TOKEN_SECRET,
  TEST_WEBHOOK_SECRET,
  type TestHarness,
} from './helpers/doubles';

/**
 * 全額返金にともなう取り消し（M3a・`UD-104` 追補）。
 *
 * ⚠️ **この組の主題は 5 つ。**
 *  1. **返金を失敗させないこと。** 取消の知らせが作れない・重複した・
 *     宛先が決まらない——どれも返金は成立させ、外へは必ず出す
 *  2. **相手が知らない受取権へ取消を送らないこと**
 *  3. **フラグが 3 つとも独立に効くこと**（未設定でも 500 にならない）
 *  4. **一部返金で推測の取り消しをしないこと**——確認事項として残す
 *  5. **補完が生成フラグに従うこと**——止めたはずのものが動かない
 */

let app: INestApplication;
let harness: TestHarness;
let outbox: InMemoryWalletDeliveryOutbox;
let reconcile: InMemoryRevocationReconcile;

const LISTING_ID = '11111111-1111-4111-8111-111111111111';
const ORDER_TOTAL = 12000;
const INTERNAL_TOKEN = 'internal-job-token';
const COMMON_USER_ID = 'cu_0123456789abcdef0123456789abcdef';
const ENTITLEMENT_ID = '3f2b1c8e-0d44-4a91-9d1e-7c5a2b6f0e13';

/** 何も書き出さないログ。⚠️ 出力の有無はここでの主題ではない。 */
const QUIET_LOGGER = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  child: () => QUIET_LOGGER,
} as unknown as Logger;

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

async function paidOrder(): Promise<string> {
  harness.artworks.seed(sampleArtwork({ maxSupply: 3 }));
  harness.listings.seed(sampleListing({ id: LISTING_ID }));
  const buyer = actorToken('buyer');

  const created = await request(app.getHttpServer())
    .post('/api/v1/orders')
    .set(auth(buyer))
    .send({ listingId: LISTING_ID, idempotencyKey: randomUUID() })
    .expect(201);
  const orderId = created.body.order.id as string;

  await request(app.getHttpServer())
    .post(`/api/v1/orders/${orderId}/checkout-session`)
    .set(auth(buyer))
    .expect(201);

  await webhook({
    id: `evt_${randomUUID()}`,
    type: 'payment.succeeded',
    data: { order_id: orderId, amount: ORDER_TOTAL, currency: 'jpy' },
  }).expect(200);

  return orderId;
}

/**
 * 取り消す対象を 1 枚だけ用意する。
 *
 * ⚠️ 返金の代替実装は受取権を持たないので、試験から明示的に置く。
 */
function seedRevocable(
  orderId: string,
  options: { readonly claimed?: boolean; readonly known?: boolean } = {},
): void {
  const claimed = options.claimed ?? true;
  harness.refunds.entitlementStatus = claimed ? 'claimed' : 'issued';
  harness.refunds.revocableEntitlements = [
    {
      id: ENTITLEMENT_ID,
      status: claimed ? 'claimed' : 'issued',
      orderLineId: 'line-1',
      artworkId: 'artwork-1',
      claimedCommonUserId: claimed ? COMMON_USER_ID : null,
    },
  ];
  if (options.known ?? true) {
    harness.refunds.grantedEntitlements.set(ENTITLEMENT_ID, {
      commonUserId: COMMON_USER_ID,
      correlationId: 'corr_0123456789',
    });
  }
  void orderId;
}

async function boot(
  options: { readonly revokeClaimed?: boolean; readonly generate?: boolean } = {},
): Promise<void> {
  harness = buildHarness(
    new DevTokenVerifier({
      secret: TEST_TOKEN_SECRET,
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
      now: () => TEST_NOW,
    }),
  );
  outbox = new InMemoryWalletDeliveryOutbox();
  reconcile = new InMemoryRevocationReconcile();
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.register({
        ...harness,
        orders: { ...harness.orders, internalJobToken: INTERNAL_TOKEN },
        revocation: {
          revokeClaimed: options.revokeClaimed ?? true,
          generationEnabled: options.generate ?? true,
          reconcile,
          outbox,
          logger: QUIET_LOGGER,
        },
      }),
    ],
  }).compile();
  app = moduleRef.createNestApplication({ rawBody: true });
  app.useGlobalFilters(new DomainErrorFilter());
  await app.init();
}

/** 事業者の画面からの一部返金。⚠️ 累計で届く（差分ではない）。 */
function partialRefundEvent(orderId: string, refundRef: string, refundedTotal: number) {
  return {
    id: `evt_${randomUUID()}`,
    type: 'payment.refunded',
    data: {
      order_id: orderId,
      amount: ORDER_TOTAL,
      currency: 'jpy',
      refund_ref: refundRef,
      refunded_total: refundedTotal,
    },
  };
}

function refund(orderId: string, token: string, body: Record<string, unknown> = {}) {
  return request(app.getHttpServer())
    .post(`/api/v1/admin/orders/${orderId}/refund`)
    .set(auth(token))
    .send({ reason: 'buyer_request', ...body });
}

afterEach(async () => {
  await app.close();
});

describe('全額返金にともなう取り消し', () => {
  beforeEach(async () => {
    await boot();
  });

  it('受取済みを取り消し、取消の知らせを 1 件作る', async () => {
    const orderId = await paidOrder();
    seedRevocable(orderId);

    await refund(orderId, actorToken('operator')).expect(201);

    expect(harness.refunds.revocationEvents.size).toBe(1);
    expect([...harness.refunds.revocationEvents.keys()]).toEqual([
      revocationEventId(ENTITLEMENT_ID),
    ]);
  });

  it('相手が知らない受取権には、取消を送らない', async () => {
    // ⚠️ 送ると相手には「知らないIDの取消」が届き続ける。
    const orderId = await paidOrder();
    seedRevocable(orderId, { claimed: false, known: false });

    await refund(orderId, actorToken('operator')).expect(201);

    expect(harness.refunds.revocationEvents.size).toBe(0);
  });

  it('宛先が決まらなければ、返金は成立させて確認事項に残す', async () => {
    const orderId = await paidOrder();
    seedRevocable(orderId, { claimed: false });
    harness.refunds.grantedEntitlements.set(ENTITLEMENT_ID, {
      commonUserId: null,
      correlationId: 'corr_0123456789',
    });

    await refund(orderId, actorToken('operator')).expect(201);

    expect(harness.refunds.revocationEvents.size).toBe(0);
    // ⚠️ 返金そのものは巻き戻さない。
    const order = await harness.orders.repository.findById(orderId);
    expect(order?.refundStatus).toBe('refunded');
  });

  it('監査には件数だけを残す（受取権IDも共通顧客IDも載せない）', async () => {
    const orderId = await paidOrder();
    seedRevocable(orderId);

    await refund(orderId, actorToken('operator')).expect(201);

    const entry = harness.audit.entries.find((row) => row.action === 'refund.succeeded');
    expect(entry?.summary).toMatchObject({ revocationEventsCreated: 1 });
    const serialized = JSON.stringify(entry?.summary ?? {});
    expect(serialized).not.toContain(COMMON_USER_ID);
    expect(serialized).not.toContain(ENTITLEMENT_ID);
  });
});

describe('フラグの効き方', () => {
  it('受取済みの取り消しを切っていれば、取り消さない', async () => {
    await boot({ revokeClaimed: false });
    const orderId = await paidOrder();
    seedRevocable(orderId);

    await refund(orderId, actorToken('operator')).expect(201);

    expect(harness.refunds.entitlementStatus).toBe('claimed');
    expect(harness.refunds.revocationEvents.size).toBe(0);
  });

  it('生成を切っていれば、取り消すが知らせは作らない', async () => {
    await boot({ generate: false });
    const orderId = await paidOrder();
    seedRevocable(orderId);

    await refund(orderId, actorToken('operator')).expect(201);

    expect(harness.refunds.entitlementStatus).toBe('revoked');
    expect(harness.refunds.revocationEvents.size).toBe(0);
  });
});

describe('一部返金', () => {
  beforeEach(async () => {
    await boot();
  });

  it('自動では取り消さず、確認事項として残す', async () => {
    /*
      ⚠️ **ログだけで済ませない。** どのシリアルを取り消すべきかは人に
         しか決められない。未対応と分かる形で残さないと埋もれる。
    */
    const orderId = await paidOrder();
    seedRevocable(orderId);

    await webhook(partialRefundEvent(orderId, 're_part', 5000)).expect(200);

    expect(harness.refunds.entitlementStatus).toBe('claimed');
    expect(harness.refunds.revocationEvents.size).toBe(0);
    const reviews = harness.operationsReviews.all;
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.reasonCode).toBe('partial_refund_entitlement_unresolved');
    expect(reviews[0]?.status).toBe('open');
  });

  it('同じ一部返金が 2 度届いても、確認事項は 1 行だけ', async () => {
    const orderId = await paidOrder();
    seedRevocable(orderId);

    await webhook(partialRefundEvent(orderId, 're_part', 5000)).expect(200);
    await webhook(partialRefundEvent(orderId, 're_part2', 6000)).expect(200);

    expect(harness.operationsReviews.all).toHaveLength(1);
  });
});

describe('取りこぼしの補完（時計が叩く口）', () => {
  it('生成が有効なら、不足している分を積む', async () => {
    await boot();
    reconcile.missing = [
      {
        entitlementId: ENTITLEMENT_ID,
        orderId: 'order-1',
        orderLineId: 'line-1',
        artworkId: 'artwork-1',
        claimedCommonUserId: COMMON_USER_ID,
        grantedCommonUserId: COMMON_USER_ID,
        grantedCorrelationId: 'corr_0123456789',
        occurredAt: TEST_NOW,
      },
    ];

    const response = await request(app.getHttpServer())
      .post('/api/v1/internal/jobs/reconcile-revocations')
      .set('x-internal-job-token', INTERNAL_TOKEN)
      .expect(200);

    expect(response.body).toMatchObject({ pickedCount: 1, createdCount: 1 });
    expect(outbox.rows.has(revocationEventId(ENTITLEMENT_ID))).toBe(true);
  });

  it('2 度実行しても増えない（冪等）', async () => {
    await boot();
    reconcile.missing = [
      {
        entitlementId: ENTITLEMENT_ID,
        orderId: 'order-1',
        orderLineId: 'line-1',
        artworkId: 'artwork-1',
        claimedCommonUserId: COMMON_USER_ID,
        grantedCommonUserId: COMMON_USER_ID,
        grantedCorrelationId: 'corr_0123456789',
        occurredAt: TEST_NOW,
      },
    ];

    await request(app.getHttpServer())
      .post('/api/v1/internal/jobs/reconcile-revocations')
      .set('x-internal-job-token', INTERNAL_TOKEN)
      .expect(200);
    const second = await request(app.getHttpServer())
      .post('/api/v1/internal/jobs/reconcile-revocations')
      .set('x-internal-job-token', INTERNAL_TOKEN)
      .expect(200);

    expect(second.body).toMatchObject({ createdCount: 0, duplicateCount: 1 });
    const revoked = [...outbox.rows.values()].filter(
      (row) => row.eventType === 'entitlement.revoked',
    );
    expect(revoked).toHaveLength(1);
  });

  it('生成が無効なら、1 行も書かずに 0 件を返す', async () => {
    /*
      ⚠️ **ここが従わないと、フラグを戻したのに時計が作り続ける。**
         「止めたはずのものが別の入口から動く」状態を作らない。
    */
    await boot({ generate: false });
    reconcile.missing = [
      {
        entitlementId: ENTITLEMENT_ID,
        orderId: 'order-1',
        orderLineId: 'line-1',
        artworkId: 'artwork-1',
        claimedCommonUserId: COMMON_USER_ID,
        grantedCommonUserId: COMMON_USER_ID,
        grantedCorrelationId: 'corr_0123456789',
        occurredAt: TEST_NOW,
      },
    ];

    const response = await request(app.getHttpServer())
      .post('/api/v1/internal/jobs/reconcile-revocations')
      .set('x-internal-job-token', INTERNAL_TOKEN)
      .expect(200);

    expect(response.body).toMatchObject({ pickedCount: 0, createdCount: 0 });
    expect(outbox.rows.size).toBe(0);
  });

  it('合言葉が違えば断る', async () => {
    await boot();
    await request(app.getHttpServer())
      .post('/api/v1/internal/jobs/reconcile-revocations')
      .set('x-internal-job-token', 'wrong')
      .expect(401);
  });
});

describe('取り消しの設定が無い配備', () => {
  it('補完の口は 500 にならず 0 件を返す', async () => {
    /*
      ⚠️ Nest の任意注入は `undefined` を渡してくる。`=== null` だけで
         見ていると素通りし、無い相手のメソッドを呼んで 500 になる
         （P0-2 で同型の不具合を出した）。
    */
    harness = buildHarness(
      new DevTokenVerifier({
        secret: TEST_TOKEN_SECRET,
        issuer: TEST_ISSUER,
        audience: TEST_AUDIENCE,
        now: () => TEST_NOW,
      }),
    );
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule.register({
          ...harness,
          orders: { ...harness.orders, internalJobToken: INTERNAL_TOKEN },
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    app.useGlobalFilters(new DomainErrorFilter());
    await app.init();

    const response = await request(app.getHttpServer())
      .post('/api/v1/internal/jobs/reconcile-revocations')
      .set('x-internal-job-token', INTERNAL_TOKEN)
      .expect(200);

    expect(response.body).toMatchObject({ pickedCount: 0, createdCount: 0, truncated: false });
  });

  it('返金そのものは従来どおり通る', async () => {
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
    app = moduleRef.createNestApplication({ rawBody: true });
    app.useGlobalFilters(new DomainErrorFilter());
    await app.init();

    const orderId = await paidOrder();
    seedRevocable(orderId, { claimed: false });

    await refund(orderId, actorToken('operator')).expect(201);
  });
});
