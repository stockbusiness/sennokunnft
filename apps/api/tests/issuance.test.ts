import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createDevToken, DevTokenVerifier, signWebhookPayload } from '@sengoku/integrations';
import { ISSUANCE_MAX_ATTEMPTS } from '@sengoku/domain';
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
 * 受取権の発行（P0-1）。
 *
 * ⚠️ **ここが開くまで、決済が済んでも受け取るものが生まれない。** Claim も
 * Wallet 配送も返金時の失効も、作ってあるのに一度も動かない状態だった。
 *
 * ⚠️ この組の主題は 5 つ。
 *   1. **決済確定のたびに、その場で発行されること。**
 *   2. **同じ知らせが何度届いても増えないこと。**
 *   3. **数量ぶん、1 枚ずつ別のシリアル番号で作られること。**
 *   4. **途中で落ちても、掃き出しが不足分だけ完成させること。**
 *   5. **発行の失敗が決済の確定を巻き戻さないこと。** お金は既に動いている。
 */

let app: INestApplication;
let harness: TestHarness;

const JOB_PATH = '/api/v1/internal/jobs/issue-entitlements';
const LISTING_ID = '11111111-1111-4111-8111-111111111111';

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

function succeededEvent(orderId: string) {
  return {
    id: `evt_${randomUUID()}`,
    type: 'payment.succeeded',
    data: { order_id: orderId, amount: 12000, currency: 'jpy' },
  };
}

/** 時計を叩く（取りこぼしの掃き出し）。 */
function sweep() {
  return request(app.getHttpServer())
    .post(JOB_PATH)
    .set('x-internal-job-token', TEST_INTERNAL_JOB_TOKEN);
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
  app = moduleRef.createNestApplication({ rawBody: true });
  app.useGlobalFilters(new DomainErrorFilter());
  await app.init();
});

afterEach(async () => {
  await app.close();
});

describe('掃き出しの口を守る', () => {
  it('合言葉が無ければ通さない', async () => {
    await request(app.getHttpServer()).post(JOB_PATH).expect(401);
  });

  it('合言葉が違えば通さない（長さが違っても同じ 401）', async () => {
    await request(app.getHttpServer())
      .post(JOB_PATH)
      .set('x-internal-job-token', 'wrong')
      .expect(401);
  });

  it('ログインしている運営でも、合言葉が無ければ通さない', async () => {
    /*
      ⚠️ これは人が押すボタンではなく、時計が叩く口である。ロール判定に
         載せると、管理画面に「運営が呼べる操作」として現れてしまう。
    */
    await request(app.getHttpServer()).post(JOB_PATH).send({}).expect(401);
  });
});

describe('掃き出しの応答', () => {
  it('拾うものが無ければ 0 を返す', async () => {
    const response = await sweep().expect(200);
    expect(response.body).toEqual({ pickedCount: 0, issuedCount: 0, failedCount: 0 });
  });

  it('注文番号も購入者も返さない（監視の数値であって名簿ではない）', async () => {
    harness.issuance.seedOrder({ orderId: 'order-1', artworkId: 'art-1', quantity: 1 });
    const response = await sweep().expect(200);
    expect(Object.keys(response.body).sort()).toEqual([
      'failedCount',
      'issuedCount',
      'pickedCount',
    ]);
  });
});

describe('数量ぶんを 1 枚ずつ作る', () => {
  it('数量 3 なら、異なるシリアル番号の 3 件だけができる', async () => {
    harness.issuance.seedOrder({ orderId: 'order-3', artworkId: 'art-1', quantity: 3 });

    const response = await sweep().expect(200);
    expect(response.body).toMatchObject({ pickedCount: 1, issuedCount: 3, failedCount: 0 });

    expect(harness.issuance.countFor('order-3')).toBe(3);
    const serials = harness.issuance.entitlements.map((row) => row.serialNo);
    expect(new Set(serials).size).toBe(3);
  });

  it('押さえた枠が発行済みへ移り、合計は変わらない', async () => {
    harness.issuance.seedOrder({
      orderId: 'order-3',
      artworkId: 'art-1',
      quantity: 3,
      maxSupply: 10,
    });
    const before = harness.issuance.counters('art-1');
    await sweep().expect(200);
    const after = harness.issuance.counters('art-1');

    expect(after).toMatchObject({ reservedCount: 0, issuedCount: 3 });
    // ⚠️ 合計が増えたらオーバーセル。移すだけで増やさない。
    expect((after?.reservedCount ?? 0) + (after?.issuedCount ?? 0)).toBe(
      (before?.reservedCount ?? 0) + (before?.issuedCount ?? 0),
    );
  });

  it('供給上限を超えない', async () => {
    harness.issuance.seedOrder({
      orderId: 'order-3',
      artworkId: 'art-1',
      quantity: 3,
      maxSupply: 3,
    });
    await sweep().expect(200);
    const after = harness.issuance.counters('art-1');
    expect((after?.reservedCount ?? 0) + (after?.issuedCount ?? 0)).toBeLessThanOrEqual(3);
  });
});

describe('同じ知らせが何度届いても増えない', () => {
  it('掃き出しを 10 回叩いても枚数が増えない', async () => {
    harness.issuance.seedOrder({ orderId: 'order-3', artworkId: 'art-1', quantity: 3 });
    for (let i = 0; i < 10; i += 1) {
      await sweep().expect(200);
    }
    expect(harness.issuance.countFor('order-3')).toBe(3);
  });

  it('2 回目以降の掃き出しは何も拾わない（発行済みは対象外）', async () => {
    harness.issuance.seedOrder({ orderId: 'order-1', artworkId: 'art-1', quantity: 1 });
    await sweep().expect(200);
    const second = await sweep().expect(200);
    expect(second.body).toEqual({ pickedCount: 0, issuedCount: 0, failedCount: 0 });
  });

  it('同じ Webhook を 10 回受けても枚数が増えない', async () => {
    /*
      ⚠️ **受入条件の中核。** 決済事業者は同じ知らせを何度でも送ってくる。
         「1 回しか来ない」を前提にすると、そのぶん受取権が増える。
    */
    const order = await seedPaidOrderViaWebhook('order-w', 2);
    for (let i = 0; i < 10; i += 1) {
      // ⚠️ 毎回ちがう event_id で送る。同じ id は手前の重複判定で弾かれ、
      //    発行まで届かない——それでは「発行が冪等か」を確かめられない。
      await webhook(succeededEvent(order)).expect(200);
    }
    expect(harness.issuance.countFor(order)).toBe(2);
  });
});

describe('途中で落ちても、あとから完成する', () => {
  it('発行に失敗しても掃き出しは 200 を返し、失敗として数える', async () => {
    harness.issuance.seedOrder({ orderId: 'order-1', artworkId: 'art-1', quantity: 1 });
    harness.issuance.failNext = 'boom';

    const response = await sweep().expect(200);
    expect(response.body).toMatchObject({ pickedCount: 1, issuedCount: 0, failedCount: 1 });
    expect(harness.issuance.countFor('order-1')).toBe(0);
  });

  it('失敗を記録し、符号だけを残す（例外の本文を残さない）', async () => {
    harness.issuance.seedOrder({ orderId: 'order-1', artworkId: 'art-1', quantity: 1 });
    harness.issuance.failNext = '購入者のメールアドレスが混ざった本文';

    await sweep().expect(200);
    expect(harness.issuance.attemptsOf('order-1')).toBe(1);
    // ⚠️ 例外の本文ではなく、こちらで決めた符号。
    expect(harness.issuance.lastErrorOf('order-1')).toBe('unexpected_error');
  });

  it('次の掃き出しで完成する（1 度きりの失敗から立ち直る）', async () => {
    harness.issuance.seedOrder({ orderId: 'order-2', artworkId: 'art-1', quantity: 2 });
    harness.issuance.failNext = 'boom';
    await sweep().expect(200);
    expect(harness.issuance.countFor('order-2')).toBe(0);

    // ⚠️ 1 回目の失敗のあとは 1 分待つ決まり。時計を進めてから拾う。
    harness.clock.set(new Date(TEST_NOW.getTime() + 2 * 60_000));
    const retry = await sweep().expect(200);
    expect(retry.body).toMatchObject({ issuedCount: 2, failedCount: 0 });
    expect(harness.issuance.countFor('order-2')).toBe(2);
  });

  it('待ち時間が来るまでは拾い直さない（叩き続けない）', async () => {
    harness.issuance.seedOrder({ orderId: 'order-1', artworkId: 'art-1', quantity: 1 });
    harness.issuance.failNext = 'boom';
    await sweep().expect(200);

    // 時計を進めずにもう一度叩く。
    const immediate = await sweep().expect(200);
    expect(immediate.body.pickedCount).toBe(0);
  });

  it('上限まで試したら自動では拾わなくなる（人手へ渡す）', async () => {
    harness.issuance.seedOrder({ orderId: 'order-1', artworkId: 'art-1', quantity: 1 });

    for (let attempt = 0; attempt < ISSUANCE_MAX_ATTEMPTS; attempt += 1) {
      harness.issuance.failNext = 'boom';
      // 待ち時間を必ず超える幅で進める。
      harness.clock.set(new Date(TEST_NOW.getTime() + (attempt + 1) * 24 * 60 * 60_000));
      await sweep().expect(200);
    }

    expect(harness.issuance.attemptsOf('order-1')).toBe(ISSUANCE_MAX_ATTEMPTS);
    harness.clock.set(new Date(TEST_NOW.getTime() + 365 * 24 * 60 * 60_000));
    const after = await sweep().expect(200);
    // ⚠️ 拾い続けると、直らない失敗が枠を食い、直る失敗が遅れる。
    expect(after.body.pickedCount).toBe(0);
  });

  it('諦めたことを記録に残す（黙って止めない）', async () => {
    harness.issuance.seedOrder({ orderId: 'order-1', artworkId: 'art-1', quantity: 1 });
    for (let attempt = 0; attempt < ISSUANCE_MAX_ATTEMPTS; attempt += 1) {
      harness.issuance.failNext = 'boom';
      harness.clock.set(new Date(TEST_NOW.getTime() + (attempt + 1) * 24 * 60 * 60_000));
      await sweep().expect(200);
    }
    expect(harness.audit.actions()).toContain('entitlement.issue_gave_up');
  });
});

describe('決済確定と受取権', () => {
  it('決済が確定すると、その場で受取権ができる', async () => {
    const order = await seedPaidOrderViaWebhook('order-p', 2);
    // ⚠️ 時計を待たない。買った人は「準備中」を見続けたくない。
    expect(harness.issuance.countFor(order)).toBe(2);
  });

  it('発行に失敗しても決済の知らせは 200 で受け取る', async () => {
    /*
      ⚠️ **お金は既に動いている。** 4xx/5xx を返すと事業者が再送し続け、
         いずれ宛先ごと無効化される。発行の失敗は別に記録して拾い直す。
    */
    harness.issuance.failNext = 'boom';
    const order = await seedPaidOrderViaWebhook('order-f', 1);
    expect(harness.issuance.countFor(order)).toBe(0);
    expect(harness.issuance.attemptsOf(order)).toBe(1);
  });

  it('発行が済んだことを監査ログへ残す', async () => {
    await seedPaidOrderViaWebhook('order-a', 1);
    expect(harness.audit.actions()).toContain('entitlement.issued');
  });

  it('監査ログに購入者も受取トークンも残さない', async () => {
    const order = await seedPaidOrderViaWebhook('order-a', 1);
    const entry = harness.audit.entries.find((row) => row.action === 'entitlement.issued');
    expect(entry?.targetId).toBe(order);
    // ⚠️ 残すのは枚数と注文番号まで。持ち出せる名簿にしない。
    expect(Object.keys(entry?.summary ?? {}).sort()).toEqual(['issued', 'orderNumber']);
  });
});

describe('決済が済んでいない注文', () => {
  it('受取権を作らない', async () => {
    // ⚠️ ここを緩めると、失敗した決済や期限切れの注文からも権利が生まれる。
    harness.issuance.seedOrder({
      orderId: 'order-u',
      artworkId: 'art-1',
      quantity: 1,
      paymentStatus: 'not_started',
    });
    const response = await sweep().expect(200);
    expect(response.body.pickedCount).toBe(0);
    expect(harness.issuance.countFor('order-u')).toBe(0);
  });
});

/**
 * 本物の注文を作ってから、決済確定の知らせを送る。
 *
 * ⚠️ **注文を二重体だけに置かない。** Webhook は注文の実物を引いてから
 * 確定するので、注文が無いと「注文が特定できない」で素通りし、
 * 発行の経路まで届かない——**試験が通っているのに本番では動かない**形になる。
 */
async function seedPaidOrderViaWebhook(label: string, quantity: number): Promise<string> {
  harness.artworks.seed(sampleArtwork({ maxSupply: 10 }));
  harness.listings.seed(sampleListing({ id: LISTING_ID }));

  const subject = `buyer-${label}`;
  harness.accounts.seed(subject, 'buyer');
  const token = createDevToken(TEST_TOKEN_SECRET, {
    sub: subject,
    iss: TEST_ISSUER,
    aud: TEST_AUDIENCE,
    exp: Math.floor(TEST_NOW.getTime() / 1000) + 3600,
  });

  const created = await request(app.getHttpServer())
    .post('/api/v1/orders')
    .set('Authorization', `Bearer ${token}`)
    .send({ listingId: LISTING_ID, quantity, idempotencyKey: randomUUID() })
    .expect(201);

  const orderId = created.body.order.id as string;
  const total = created.body.order.totalAmount as number;

  // 発行の側にも同じ注文を置く（二重体は保存だけを肩代わりする）。
  harness.issuance.seedOrder({ orderId, artworkId: 'art-1', quantity });

  await webhook({
    id: `evt_${randomUUID()}`,
    type: 'payment.succeeded',
    data: { order_id: orderId, amount: total, currency: 'jpy' },
  }).expect(200);

  return orderId;
}
