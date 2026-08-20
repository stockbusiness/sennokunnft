import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { finalizeConsumedReservation } from '@sengoku/domain';
import type { PrismaClient } from '../../generated/client';
import { PrismaPaymentRepository } from '../../src/repositories/payment.repository';
import { PrismaOrderRepository } from '../../src/repositories/order.repository';
import {
  createTestClient,
  integrationTestsAvailable,
  orderLineSeedFields,
  orderSeedFields,
  resetDatabase,
  violatesUniqueConstraint,
} from '../helpers/database';

/**
 * 決済まわりを実 PostgreSQL に対して確かめる（決済 Phase P2）。
 *
 * ⚠️ **Stripe へは繋がない。** ここで見るのは、こちらの DB が
 * 何を許して何を拒むか。事業者とのやり取りは Adapter の単体試験と
 * テストモードの通し試験が受け持つ。
 */
const enabled = integrationTestsAvailable();
const suite = enabled ? describe : describe.skip;

let prisma: PrismaClient;
let payments: PrismaPaymentRepository;
let orders: PrismaOrderRepository;

const NOW = new Date('2026-08-19T00:00:00.000Z');
const EXPIRES_AT = new Date('2026-08-19T00:30:00.000Z');
const PROVIDER = 'stripe';

beforeAll(async () => {
  if (!enabled) return;
  prisma = createTestClient();
  await prisma.$connect();
  payments = new PrismaPaymentRepository(prisma);
  orders = new PrismaOrderRepository(prisma);
});

afterAll(async () => {
  if (!enabled) return;
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!enabled) return;
  await resetDatabase(prisma);
});

interface Seeded {
  readonly accountId: string;
  readonly creatorAccountId: string;
  readonly artworkId: string;
  readonly listingId: string;
  readonly orderId: string;
}

/** 買われて、在庫を押さえた状態の注文を 1 件つくる。 */
async function seedOrder(maxSupply = 3): Promise<Seeded> {
  const accountId = randomUUID();
  const creatorAccountId = randomUUID();
  await prisma.account.createMany({
    data: [
      { id: accountId, authProvider: 'fake', authSubject: accountId },
      { id: creatorAccountId, authProvider: 'fake', authSubject: creatorAccountId },
    ],
  });
  const artwork = await prisma.artwork.create({
    data: {
      creatorAccountId,
      slug: `artwork-${randomUUID()}`,
      title: '天下布武の陣羽織',
      maxSupply,
      status: 'published',
    },
  });
  const listing = await prisma.listing.create({
    data: { artworkId: artwork.id, priceAmount: 12000, priceCurrency: 'JPY', status: 'active' },
  });

  const orderId = randomUUID();
  await prisma.order.create({
    data: {
      id: orderId,
      accountId,
      totalAmount: 12000,
      totalCurrency: 'JPY',
      idempotencyKey: randomUUID(),
      reservedUntil: EXPIRES_AT,
      ...orderSeedFields({ creatorAccountId, totalAmount: 12000 }),
      // ✅ 承認済み 20%。配分は 80%。
      platformFeeRateBps: 2000,
      platformFeeAmount: 2400,
      creatorAmount: 9600,
    },
  });
  await prisma.orderLine.create({
    data: {
      orderId,
      listingId: listing.id,
      artworkId: artwork.id,
      artworkTitleSnapshot: '天下布武の陣羽織',
      unitPriceAmount: 12000,
      unitPriceCurrency: 'JPY',
      quantity: 1,
      ...orderLineSeedFields({ creatorAccountId, unitPriceAmount: 12000, quantity: 1 }),
    },
  });
  await prisma.inventoryReservation.create({
    data: {
      orderId,
      listingId: listing.id,
      artworkId: artwork.id,
      quantity: 1,
      status: 'reserved',
      expiresAt: EXPIRES_AT,
    },
  });
  await prisma.artwork.update({ where: { id: artwork.id }, data: { reservedCount: 1 } });

  return { accountId, creatorAccountId, artworkId: artwork.id, listingId: listing.id, orderId };
}

async function recordSession(seeded: Seeded, attempt = 0) {
  return payments.recordCheckoutSession({
    paymentId: randomUUID(),
    orderId: seeded.orderId,
    provider: PROVIDER,
    credentialId: null,
    sessionRef: `cs_test_${seeded.orderId}_${String(attempt)}`,
    paymentRef: `pi_test_${seeded.orderId}_${String(attempt)}`,
    url: `https://checkout.example.test/${String(attempt)}`,
    amount: 12000,
    currency: 'JPY',
    idempotencyKey: `order:${seeded.orderId}:attempt:${String(attempt)}`,
    expiresAt: EXPIRES_AT,
    now: NOW,
  });
}

function confirmCommand(seeded: Seeded, attempt = 0) {
  return {
    orderId: seeded.orderId,
    provider: PROVIDER,
    eventId: `evt_${randomUUID()}`,
    sessionRef: `cs_test_${seeded.orderId}_${String(attempt)}`,
    paymentRef: `pi_test_${seeded.orderId}_${String(attempt)}`,
    chargeRef: `ch_test_${randomUUID()}`,
    amount: 12000,
    currency: 'JPY',
    paidAt: NOW,
    /*
      返金を受け付ける期限（`UD-104`）。
      ⚠️ **決済確定の瞬間に決めて渡す。** リポジトリ側で設定を読み直さない。
         読み直すと、日数を変えた瞬間に過去の注文の期限が動く。
    */
    refundableUntil: new Date(NOW.getTime() + 14 * 86_400_000),
    outboxEventId: randomUUID(),
    now: NOW,
  };
}

suite('決済成功の確定（決定A）', () => {
  it('注文・決済・予約が同時に進む', async () => {
    const seeded = await seedOrder();
    await recordSession(seeded);

    expect(await payments.confirmPayment(confirmCommand(seeded))).toBe(true);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: seeded.orderId } });
    expect(order.status).toBe('paid');
    expect(order.paymentStatus).toBe('succeeded');
    expect(order.paidAt).not.toBeNull();
    /*
      ⚠️ **返金の期限は、決済確定と同じ更新で焼き付ける**（`UD-104`）。
         別の更新に分けると、片方だけ通った注文が残り、
         「支払い済みだが期限が無い」＝返金の判定を通らない行になる。
    */
    expect(order.refundableUntil?.getTime()).toBe(NOW.getTime() + 14 * 86_400_000);

    const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: seeded.orderId } });
    expect(payment.status).toBe('succeeded');
    expect(payment.paidAt).not.toBeNull();

    const reservation = await prisma.inventoryReservation.findFirstOrThrow({
      where: { orderId: seeded.orderId },
    });
    expect(reservation.status).toBe('consumed');
  });

  it('【1】issuedCount を増やさない', async () => {
    // ⚠️ 受取権を作っていないのに増やすと、シリアル番号の採番がずれる。
    const seeded = await seedOrder();
    await recordSession(seeded);
    await payments.confirmPayment(confirmCommand(seeded));

    const artwork = await prisma.artwork.findUniqueOrThrow({ where: { id: seeded.artworkId } });
    expect(artwork.issuedCount).toBe(0);
  });

  it('【2】reservedCount を減らさない', async () => {
    /*
      ⚠️ 減らすと、受取権を作る前のわずかな間だけ販売枠が復活する。
         その隙に他の人が買うと、売れた注文の発行が上限で弾かれる。
    */
    const seeded = await seedOrder();
    await recordSession(seeded);
    await payments.confirmPayment(confirmCommand(seeded));

    const artwork = await prisma.artwork.findUniqueOrThrow({ where: { id: seeded.artworkId } });
    expect(artwork.reservedCount).toBe(1);
  });

  it('【4】consumed の枠は新しい購入へ回らない', async () => {
    const seeded = await seedOrder(1);
    await recordSession(seeded);
    await payments.confirmPayment(confirmCommand(seeded));

    // 在庫 1 の作品。決済が済んでいても、次の人は買えない。
    const artwork = await prisma.artwork.findUniqueOrThrow({ where: { id: seeded.artworkId } });
    expect(artwork.maxSupply - artwork.reservedCount - artwork.issuedCount).toBe(0);
  });

  it('【6】同じ注文を 2 回確定しても、出来事は 1 件だけ', async () => {
    const seeded = await seedOrder();
    await recordSession(seeded);

    expect(await payments.confirmPayment(confirmCommand(seeded))).toBe(true);
    // ⚠️ 2 回目は何もしない。条件付き更新が止める。
    expect(await payments.confirmPayment(confirmCommand(seeded))).toBe(false);

    expect(await prisma.outboxEvent.count({ where: { aggregateId: seeded.orderId } })).toBe(1);
  });

  it('同時に確定しても、出来事は 1 件だけ', async () => {
    const seeded = await seedOrder();
    await recordSession(seeded);

    const results = await Promise.all([
      payments.confirmPayment(confirmCommand(seeded)),
      payments.confirmPayment(confirmCommand(seeded)),
      payments.confirmPayment(confirmCommand(seeded)),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await prisma.outboxEvent.count({ where: { aggregateId: seeded.orderId } })).toBe(1);
  });

  it('【5】Phase P3 相当の確定で、reserved から issued へ 1 回だけ移る', async () => {
    /*
      ⚠️ 受取権を作るのと同じ場面を模した検査。決済 Phase P2 では
         この移動を**しない**が、次の工程でしたときに帳尻が合うことを
         いま確かめておく。合わないと、P3 の実装中に気づくことになる。
    */
    const seeded = await seedOrder();
    await recordSession(seeded);
    await payments.confirmPayment(confirmCommand(seeded));

    const before = await prisma.artwork.findUniqueOrThrow({ where: { id: seeded.artworkId } });
    const moved = finalizeConsumedReservation(before, 1);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;

    await prisma.artwork.update({
      where: { id: seeded.artworkId },
      data: { reservedCount: moved.value.reservedCount, issuedCount: moved.value.issuedCount },
    });

    const after = await prisma.artwork.findUniqueOrThrow({ where: { id: seeded.artworkId } });
    expect(after.reservedCount).toBe(0);
    expect(after.issuedCount).toBe(1);
    // 合計は変わらない。ここが増えるとオーバーセル。
    expect(after.reservedCount + after.issuedCount).toBe(1);
  });
});

suite('決済の記録の制約', () => {
  it('【11】1 注文に成功した決済を 2 件作れない', async () => {
    // ⚠️ 2 件あると、二重に受け取ったのか記録の誤りなのか区別できない。
    const seeded = await seedOrder();
    await recordSession(seeded, 0);
    await payments.confirmPayment(confirmCommand(seeded, 0));

    await recordSession(seeded, 1);
    await expect(
      prisma.payment.updateMany({
        where: { orderId: seeded.orderId, status: 'pending' },
        data: { status: 'succeeded', paidAt: NOW },
      }),
    ).rejects.toSatisfy((error) => violatesUniqueConstraint(error));
  });

  it('成功した決済には支払時刻が要る', async () => {
    const seeded = await seedOrder();
    const attempt = await recordSession(seeded);
    await expect(
      prisma.payment.update({
        where: { id: attempt.id },
        data: { status: 'succeeded' },
      }),
    ).rejects.toThrow();
  });

  it('同じ支払い口の識別子を 2 件作れない', async () => {
    const seeded = await seedOrder();
    await recordSession(seeded, 0);
    await expect(
      prisma.payment.create({
        data: {
          orderId: seeded.orderId,
          provider: PROVIDER,
          providerSessionRef: `cs_test_${seeded.orderId}_0`,
          status: 'pending',
          amount: 12000,
          currency: 'JPY',
        },
      }),
    ).rejects.toSatisfy((error) => violatesUniqueConstraint(error));
  });

  it('【8・9】同じ冪等キーなら同じ記録を返し、違えば新しく作る', async () => {
    const seeded = await seedOrder();
    const first = await recordSession(seeded, 0);
    const same = await recordSession(seeded, 0);
    expect(same.id).toBe(first.id);

    // 試行回数が変われば別の記録。⚠️ 履歴は消さない（決定 B）。
    const second = await recordSession(seeded, 1);
    expect(second.id).not.toBe(first.id);
    expect(await payments.listAttempts(seeded.orderId)).toHaveLength(2);
  });

  it('同時に同じ冪等キーで呼んでも記録は 1 件', async () => {
    const seeded = await seedOrder();
    await Promise.all([recordSession(seeded, 0), recordSession(seeded, 0)]);
    expect(await payments.listAttempts(seeded.orderId)).toHaveLength(1);
  });
});

suite('Webhook の受信記録', () => {
  const base = {
    provider: PROVIDER,
    eventType: 'checkout.session.completed',
    apiVersion: '2026-07-29.dahlia',
    livemode: false,
    credentialId: null,
    payloadDigest: 'sha256:dummy',
    now: NOW,
  };

  it('初回は処理してよい、2 回目は重複として返す', async () => {
    const seeded = await seedOrder();
    const eventId = `evt_${randomUUID()}`;

    const first = await payments.claimWebhookEvent({
      ...base,
      id: randomUUID(),
      eventId,
      orderId: seeded.orderId,
    });
    const second = await payments.claimWebhookEvent({
      ...base,
      id: randomUUID(),
      eventId,
      orderId: seeded.orderId,
    });

    expect(first.kind).toBe('claimed');
    expect(second.kind).toBe('duplicate');

    const row = await prisma.webhookEvent.findFirstOrThrow({ where: { eventId } });
    // 受け取った回数は数える。取りこぼしの調査に要る。
    expect(row.attemptCount).toBe(2);
  });

  it('同時に届いても 1 本しか処理へ進まない', async () => {
    // ⚠️ 「探して無ければ書く」だと、両方とも処理へ進んでしまう。
    const seeded = await seedOrder();
    const eventId = `evt_${randomUUID()}`;
    const results = await Promise.all([
      payments.claimWebhookEvent({ ...base, id: randomUUID(), eventId, orderId: seeded.orderId }),
      payments.claimWebhookEvent({ ...base, id: randomUUID(), eventId, orderId: seeded.orderId }),
    ]);

    expect(results.filter((result) => result.kind === 'claimed')).toHaveLength(1);
  });

  it('本文の全体を保存しない', async () => {
    // ⚠️ カード情報・個人情報が混ざる余地を作らない。残すのは digest だけ。
    const eventId = `evt_${randomUUID()}`;
    await payments.claimWebhookEvent({ ...base, id: randomUUID(), eventId, orderId: null });
    const row = await prisma.webhookEvent.findFirstOrThrow({ where: { eventId } });
    expect(Object.keys(row)).not.toContain('payload');
    expect(row.payloadDigest.startsWith('sha256:')).toBe(true);
  });
});

suite('支払い口の期限切れ（指示書 §8）', () => {
  it('注文を閉じ、在庫を戻す', async () => {
    const seeded = await seedOrder();
    await recordSession(seeded);

    expect(
      await payments.expireCheckout({ orderId: seeded.orderId, sessionRef: null, now: NOW }),
    ).toBe(true);

    const artwork = await prisma.artwork.findUniqueOrThrow({ where: { id: seeded.artworkId } });
    expect(artwork.reservedCount).toBe(0);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: seeded.orderId } });
    expect(order.status).toBe('expired');
  });

  it('既存の解放ジョブと二重に解放しない', async () => {
    /*
      ⚠️ どちらが先に動いても在庫は 1 回しか戻らない。二重に戻ると、
         在庫が実際より多く見え、売れない物が売れる。
    */
    const seeded = await seedOrder();
    await recordSession(seeded);

    // 先に解放ジョブが動く。
    const released = await orders.releaseExpiredReservations(
      new Date(EXPIRES_AT.getTime() + 1000),
      100,
    );
    expect(released).toHaveLength(1);

    // あとから期限切れの知らせが届く。
    expect(
      await payments.expireCheckout({ orderId: seeded.orderId, sessionRef: null, now: NOW }),
    ).toBe(false);

    const artwork = await prisma.artwork.findUniqueOrThrow({ where: { id: seeded.artworkId } });
    expect(artwork.reservedCount).toBe(0);
  });

  it('同時に走っても在庫は 1 回しか戻らない', async () => {
    const seeded = await seedOrder();
    await recordSession(seeded);

    await Promise.all([
      payments.expireCheckout({ orderId: seeded.orderId, sessionRef: null, now: NOW }),
      orders.releaseExpiredReservations(new Date(EXPIRES_AT.getTime() + 1000), 100),
    ]);

    const artwork = await prisma.artwork.findUniqueOrThrow({ where: { id: seeded.artworkId } });
    expect(artwork.reservedCount).toBe(0);
  });
});

suite('決済失敗（決定B）', () => {
  it('【7】注文は checkout_created のまま、記録は残る', async () => {
    const seeded = await seedOrder();
    await recordSession(seeded, 0);

    await payments.recordFailure({
      orderId: seeded.orderId,
      sessionRef: `cs_test_${seeded.orderId}_0`,
      paymentRef: null,
      failureCode: 'card_declined',
      now: NOW,
    });

    const order = await prisma.order.findUniqueOrThrow({ where: { id: seeded.orderId } });
    expect(order.status).toBe('checkout_created');
    expect(order.paymentStatus).toBe('failed');

    // ⚠️ 在庫は押さえたまま。期限内なら再試行できる。
    const artwork = await prisma.artwork.findUniqueOrThrow({ where: { id: seeded.artworkId } });
    expect(artwork.reservedCount).toBe(1);

    // 試行の記録は消さない。
    const attempts = await payments.listAttempts(seeded.orderId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe('failed');
    expect(attempts[0]?.failureCode).toBe('card_declined');
  });
});
