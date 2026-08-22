import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../../generated/client';
import { PrismaOperationsRepository } from '../../src/repositories/operations.repository';
import {
  createTestClient,
  integrationTestsAvailable,
  orderLineSeedFields,
  orderSeedFields,
  resetDatabase,
  violatesConstraint,
} from '../helpers/database';

/**
 * 運営ダッシュボードの数え上げ（実運営 指示書 P0-6）。
 *
 * ⚠️ ここで見たいのは 4 つ。
 *  1. **「本日」が JST の 1 日であること。** UTC で切ると、日本の朝 9 時前の
 *     ご注文が前日に混ざり、朝礼の数字が毎日ずれる
 *  2. **失敗しても「最後に成功した時刻」を消さないこと。** 消すと、
 *     見たい値そのものが失われる
 *  3. **記録の無い時計仕掛けも項目として返すこと。** 返さないと、画面から
 *     項目ごと消え、「動いていない」ではなく「そんな処理は無い」に見える
 *  4. **食い違いを見つけられること。** 0 件が正常だが、0 件しか作れない
 *     試験では「見つけられること」を確かめられない
 */
const enabled = integrationTestsAvailable();
const suite = enabled ? describe : describe.skip;

/** JST では 2026/08/21 09:00。 */
const NOW = new Date('2026-08-21T00:00:00.000Z');
/*
  「証拠の提出期限が近い」の境目（2026-08-22）。
  ⚠️ **試験からも明示する。** 既定値に頼ると、既定を変えたときに
     何を確かめていたのかが読めなくなる。
*/
const DUE_SOON_BEFORE = new Date('2026-08-24T00:00:00.000Z');
const PRICE = 12_000;

let prisma: PrismaClient;
let repo: PrismaOperationsRepository;

beforeAll(async () => {
  if (!enabled) return;
  prisma = createTestClient();
  await prisma.$connect();
  repo = new PrismaOperationsRepository(prisma);
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
  readonly orderId: string;
  readonly orderLineId: string;
  readonly artworkId: string;
  readonly accountId: string;
}

async function seedPaidOrder(
  options: { quantity?: number; createdAt?: Date; paidAt?: Date } = {},
): Promise<Seeded> {
  const quantity = options.quantity ?? 1;
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
      title: '運営の試験の作品',
      maxSupply: 10,
      reservedCount: quantity,
      status: 'published',
    },
  });
  const listing = await prisma.listing.create({
    data: { artworkId: artwork.id, priceAmount: PRICE, priceCurrency: 'JPY' },
  });
  const order = await prisma.order.create({
    data: {
      accountId,
      totalAmount: PRICE * quantity,
      totalCurrency: 'JPY',
      idempotencyKey: randomUUID(),
      status: 'paid',
      paymentStatus: 'succeeded',
      paidAt: options.paidAt ?? NOW,
      ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt }),
      ...orderSeedFields({ creatorAccountId, totalAmount: PRICE * quantity }),
      subtotalAmount: PRICE * quantity,
      creatorAmount: PRICE * quantity,
    },
  });
  const line = await prisma.orderLine.create({
    data: {
      orderId: order.id,
      listingId: listing.id,
      artworkId: artwork.id,
      artworkTitleSnapshot: '運営の試験の作品',
      unitPriceAmount: PRICE,
      unitPriceCurrency: 'JPY',
      quantity,
      ...orderLineSeedFields({ creatorAccountId, unitPriceAmount: PRICE, quantity }),
    },
  });
  return { orderId: order.id, orderLineId: line.id, artworkId: artwork.id, accountId };
}

suite('本日の数え方（JST）', () => {
  /*
    ⚠️ **UTC の 0 時で切らない。** JST の 2026/08/21 は
       UTC では 2026/08/20 15:00 から 2026/08/21 15:00 まで。
  */
  it('JST の当日ぶんだけを数える', async () => {
    // JST 2026/08/21 08:00（UTC では前日の 23:00）。当日に入る。
    await seedPaidOrder({ createdAt: new Date('2026-08-20T23:00:00.000Z') });
    // JST 2026/08/20 23:00（UTC では 14:00）。前日なので入らない。
    await seedPaidOrder({ createdAt: new Date('2026-08-20T14:00:00.000Z') });

    const counts = await repo.counts(NOW, DUE_SOON_BEFORE);
    expect(counts.todayOrderCount).toBe(1);
  });

  it('お支払い済みの金額と件数を数える', async () => {
    const seeded = await seedPaidOrder();
    await prisma.payment.create({
      data: {
        orderId: seeded.orderId,
        provider: 'stripe',
        status: 'succeeded',
        amount: PRICE,
        currency: 'JPY',
        paidAt: NOW,
      },
    });

    const counts = await repo.counts(NOW, DUE_SOON_BEFORE);
    expect(counts.todayPaidAmount).toBe(PRICE);
    expect(counts.todayPaidCount).toBe(1);
  });

  it('決済の知らせの最終受信を返す', async () => {
    const received = new Date('2026-08-20T22:00:00.000Z');
    await prisma.webhookEvent.create({
      data: {
        provider: 'stripe',
        eventId: `evt_${randomUUID()}`,
        eventType: 'payment_intent.succeeded',
        receivedAt: received,
        payloadDigest: `sha256:${'a'.repeat(64)}`,
      },
    });
    const counts = await repo.counts(NOW, DUE_SOON_BEFORE);
    expect(counts.lastWebhookReceivedAt?.toISOString()).toBe(received.toISOString());
  });

  it('何も無ければ 0 と null（0 件を「取得できない」にしない）', async () => {
    const counts = await repo.counts(NOW, DUE_SOON_BEFORE);
    expect(counts.todayOrderCount).toBe(0);
    expect(counts.todayPaidAmount).toBe(0);
    expect(counts.lastWebhookReceivedAt).toBeNull();
  });
});

suite('時計仕掛けの記録', () => {
  /*
    ⚠️ **記録の無い種別も返す。** 返さないと画面から項目ごと消え、
       「動いていない」ではなく「そんな処理は無い」に見える。
  */
  it('一度も動いていない種別も項目として返す', async () => {
    const rows = await repo.heartbeats(['issue-entitlements', 'send-notifications']);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.lastSucceededAt === null)).toBe(true);
    expect(rows.every((row) => row.lastOutcome === null)).toBe(true);
  });

  it('成功を記録すると、最終成功が入る', async () => {
    await repo.recordJobRun({ jobKey: 'issue-entitlements', outcome: 'succeeded', now: NOW });
    const [row] = await repo.heartbeats(['issue-entitlements']);
    expect(row?.lastSucceededAt?.toISOString()).toBe(NOW.toISOString());
    expect(row?.lastOutcome).toBe('succeeded');
  });

  /*
    ⚠️ **この試験が本題。** 失敗のたびに成功の時刻を消すと、
       「最後にいつ成功したか」——見たい値そのもの——が失われる。
  */
  it('あとから失敗しても、最終成功の時刻は消えない', async () => {
    await repo.recordJobRun({ jobKey: 'issue-entitlements', outcome: 'succeeded', now: NOW });
    const later = new Date(NOW.getTime() + 3_600_000);
    await repo.recordJobRun({
      jobKey: 'issue-entitlements',
      outcome: 'failed',
      errorCode: 'BOOM',
      now: later,
    });

    const [row] = await repo.heartbeats(['issue-entitlements']);
    expect(row?.lastSucceededAt?.toISOString()).toBe(NOW.toISOString());
    expect(row?.lastFailedAt?.toISOString()).toBe(later.toISOString());
    expect(row?.lastOutcome).toBe('failed');
  });

  it('何度記録しても種別ごとに 1 行（履歴を溜めない）', async () => {
    await repo.recordJobRun({ jobKey: 'issue-entitlements', outcome: 'succeeded', now: NOW });
    await repo.recordJobRun({ jobKey: 'issue-entitlements', outcome: 'succeeded', now: NOW });
    expect(await prisma.jobRun.count({ where: { jobKey: 'issue-entitlements' } })).toBe(1);
  });

  /*
    ⚠️ **語彙を DB でも閉じる。** アプリの判定に穴が開いたときに残る
       最後の砦。知らない語が入ると、画面の色が決まらなくなる。
  */
  it('知らない結果は DB が拒む', async () => {
    await expect(
      prisma.jobRun.create({
        data: {
          jobKey: 'bogus-job',
          lastOutcome: 'maybe',
          lastSucceededAt: NOW,
          updatedAt: NOW,
        },
      }),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'job_runs_last_outcome_known'),
    );
  });
});

suite('記録の食い違い', () => {
  it('食い違いが無ければ、すべて空で返る', async () => {
    const found = await repo.consistency();
    expect(found.paidWithoutEntitlements).toEqual([]);
    expect(found.supplyDrift).toEqual([]);
    expect(found.unmaskedRecipient).toEqual([]);
  });

  /*
    ⚠️ **お金を受け取ったのに、お渡しするものが無い状態。** いちばん重い。
  */
  it('支払い済みで受取権が足りない注文を見つける', async () => {
    const seeded = await seedPaidOrder({ quantity: 2 });
    const found = await repo.consistency();
    expect(found.paidWithoutEntitlements).toContain(seeded.orderId);
  });

  it('受取権がそろえば見つからない', async () => {
    const seeded = await seedPaidOrder({ quantity: 1 });
    await prisma.entitlement.create({
      data: {
        orderId: seeded.orderId,
        orderLineId: seeded.orderLineId,
        artworkId: seeded.artworkId,
        accountId: seeded.accountId,
        serialNo: 1,
        unitIndex: 0,
        claimTokenHash: `sha256:${'b'.repeat(64)}`,
        status: 'issued',
      },
    });
    await prisma.artwork.update({
      where: { id: seeded.artworkId },
      data: { issuedCount: 1, reservedCount: 0 },
    });

    const found = await repo.consistency();
    expect(found.paidWithoutEntitlements).not.toContain(seeded.orderId);
    expect(found.supplyDrift).not.toContain(seeded.artworkId);
  });

  /*
    ⚠️ **数え間違いは売り越しにつながる。** 直さず、まず気づけるようにする。
  */
  it('発行済み数と受取権の実数のずれを見つける', async () => {
    const seeded = await seedPaidOrder({ quantity: 1 });
    // 受取権は 0 件のまま、数だけ 1 に進める。
    await prisma.artwork.update({
      where: { id: seeded.artworkId },
      data: { issuedCount: 1, reservedCount: 0 },
    });

    const found = await repo.consistency();
    expect(found.supplyDrift).toContain(seeded.artworkId);
  });

  it('お受け取り済みなのに配送の記録が無い受取権を見つける', async () => {
    const seeded = await seedPaidOrder({ quantity: 1 });
    const entitlement = await prisma.entitlement.create({
      data: {
        orderId: seeded.orderId,
        orderLineId: seeded.orderLineId,
        artworkId: seeded.artworkId,
        accountId: seeded.accountId,
        serialNo: 1,
        unitIndex: 0,
        claimTokenHash: `sha256:${'c'.repeat(64)}`,
        status: 'claimed',
        /*
          ⚠️ **受取の時刻と受け取った方は必ず対で入る**（M3a で足した CHECK）。
             片方だけでは DB が受け付けない。
        */
        claimedAt: NOW,
        claimedByAccountId: seeded.accountId,
        // ⚠️ 代理店システムの契約は `cu_` + 32 桁の 16 進（DB の CHECK が見る）。
        claimedByCommonUserId: `cu_${randomUUID().replaceAll('-', '')}`,
      },
    });
    await prisma.artwork.update({
      where: { id: seeded.artworkId },
      data: { issuedCount: 1, reservedCount: 0 },
    });

    const found = await repo.consistency();
    expect(found.claimedWithoutDelivery).toContain(entitlement.id);
  });
});
