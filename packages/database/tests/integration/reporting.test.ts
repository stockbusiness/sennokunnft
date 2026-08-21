import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../../generated/client';
import {
  PrismaCreatorDirectoryRepository,
  PrismaSalesReportRepository,
} from '../../src/repositories/reporting.repository';
import { createTestClient, integrationTestsAvailable, resetDatabase } from '../helpers/database';

/**
 * 運営の売上レポートと作家さまの一覧（`UD-123` / `UD-124` の一部）。
 *
 * ⚠️ **ここで見たいのは 5 つ。**
 *  1. **JST で区切れていること**——UTC で切ると締めが 1 日ずれる
 *  2. **試し売り（`STAGING_FIXTURE`）が混ざらないこと**
 *  3. **成立していない返金を引かないこと**
 *  4. 返金を**成立した日**で数えていること（過去の月が動かない）
 *  5. 作家さまの一覧で**件数が掛け算にならないこと**（扇形結合）
 */
const enabled = integrationTestsAvailable();
const suite = enabled ? describe : describe.skip;

let prisma: PrismaClient;
let sales: PrismaSalesReportRepository;
let creators: PrismaCreatorDirectoryRepository;

/** 2026-08-01〜09-01（JST）。 */
const PERIOD = {
  granularity: 'daily' as const,
  from: new Date('2026-08-01T00:00:00.000+09:00'),
  to: new Date('2026-09-01T00:00:00.000+09:00'),
};

beforeAll(() => {
  if (!enabled) return;
  prisma = createTestClient();
  sales = new PrismaSalesReportRepository(prisma);
  creators = new PrismaCreatorDirectoryRepository(prisma);
});

afterAll(async () => {
  if (enabled) await prisma.$disconnect();
});

let creatorId: string;
let buyerId: string;
let artworkId: string;

beforeEach(async () => {
  if (!enabled) return;
  await resetDatabase(prisma);
  creatorId = randomUUID();
  buyerId = randomUUID();
  artworkId = randomUUID();

  await prisma.account.create({
    data: {
      id: creatorId,
      authProvider: 'test',
      authSubject: `creator-${creatorId}`,
      displayName: '千ノ国 太郎',
      displayNameKey: `せんのくに-${creatorId}`,
    },
  });
  await prisma.account.create({
    data: { id: buyerId, authProvider: 'test', authSubject: `buyer-${buyerId}` },
  });
  await prisma.artwork.create({
    data: {
      id: artworkId,
      slug: `slug-${artworkId}`,
      title: '天下布武の陣羽織',
      status: 'published',
      maxSupply: 10,
      creatorAccountId: creatorId,
    },
  });
});

async function seedOrder(input: {
  readonly paidAt: Date | null;
  readonly paymentStatus?: string;
  readonly source?: 'PURCHASE' | 'STAGING_FIXTURE';
  readonly totalAmount?: number;
}): Promise<string> {
  const order = await prisma.order.create({
    data: {
      orderNumber: `SNK-${randomUUID().slice(0, 8).toUpperCase()}`,
      accountId: buyerId,
      creatorAccountId: creatorId,
      // ⚠️ DB の CHECK（`orders_paid_has_time`）が、状態と時刻の食い違いを止める。
      status: input.paidAt === null ? 'pending' : 'paid',
      source: input.source ?? 'PURCHASE',
      subtotalAmount: input.totalAmount ?? 12000,
      totalAmount: input.totalAmount ?? 12000,
      totalCurrency: 'JPY',
      platformFeeRateBps: 2000,
      platformFeeAmount: Math.floor((input.totalAmount ?? 12000) * 0.2),
      creatorAmount: (input.totalAmount ?? 12000) - Math.floor((input.totalAmount ?? 12000) * 0.2),
      paymentStatus: input.paymentStatus ?? 'succeeded',
      paidAt: input.paidAt,
      idempotencyKey: randomUUID(),
    },
  });
  return order.id;
}

suite('売上の集計', () => {
  /*
    ⚠️ **JST で切る。** UTC で切ると、日本時間の朝に売れた分が前日に
       計上される。会計の締めが 1 日ずれる。
  */
  it('JST の日付で区切る', async () => {
    // 2026-08-20 08:00 JST（= 2026-08-19 23:00 UTC）。JST ではまだ 20 日。
    await seedOrder({ paidAt: new Date('2026-08-19T23:00:00.000Z') });

    const rows = await sales.aggregateSales(PERIOD);
    expect(rows).toEqual([
      {
        periodKey: '2026-08-20',
        orderCount: 1,
        grossAmount: 12000,
        platformFeeAmount: 2400,
        creatorAmount: 9600,
      },
    ]);
  });

  /*
    ⚠️ **試し売りを混ぜない。** 混ざると、会計へ渡す表に存在しない売上が
       載る。除き忘れても画面は何も言わない。
  */
  it('試し売りの注文を数えない', async () => {
    await seedOrder({ paidAt: new Date('2026-08-20T00:00:00.000Z') });
    await seedOrder({
      paidAt: new Date('2026-08-20T00:00:00.000Z'),
      source: 'STAGING_FIXTURE',
      totalAmount: 999999,
    });

    const rows = await sales.aggregateSales(PERIOD);
    expect(rows).toHaveLength(1);
    // ⚠️ 空振りでないことを確かめる（1 件は数えられている）。
    expect(rows[0]?.orderCount).toBe(1);
    expect(rows[0]?.grossAmount).toBe(12000);
  });

  it('支払いが成立していない注文を数えない', async () => {
    await seedOrder({ paidAt: null, paymentStatus: 'not_started' });
    // ⚠️ 支払日はあるが決済は失敗、という行。`paid_at` だけで数えると混ざる。
    await seedOrder({ paidAt: new Date('2026-08-20T00:00:00.000Z'), paymentStatus: 'failed' });

    expect(await sales.aggregateSales(PERIOD)).toEqual([]);
  });

  it('期間の外を数えない', async () => {
    // 2026-09-01 00:00 JST は `to`（含まない）。
    await seedOrder({ paidAt: new Date('2026-08-31T15:00:00.000Z') });
    expect(await sales.aggregateSales(PERIOD)).toEqual([]);
  });

  it('月次でまとめられる', async () => {
    await seedOrder({ paidAt: new Date('2026-08-05T00:00:00.000Z') });
    await seedOrder({ paidAt: new Date('2026-08-20T00:00:00.000Z') });

    const rows = await sales.aggregateSales({ ...PERIOD, granularity: 'monthly' });
    expect(rows).toEqual([
      {
        periodKey: '2026-08',
        orderCount: 2,
        grossAmount: 24000,
        platformFeeAmount: 4800,
        creatorAmount: 19200,
      },
    ]);
  });
});

suite('返金の集計', () => {
  async function seedRefund(input: {
    readonly orderId: string;
    readonly status: string;
    readonly settledAt: Date | null;
    readonly amount?: number;
  }): Promise<void> {
    await prisma.refund.create({
      data: {
        orderId: input.orderId,
        amount: input.amount ?? 12000,
        currency: 'JPY',
        reason: 'buyer_request',
        initiatedBy: 'provider',
        status: input.status,
        settledAt: input.settledAt,
      },
    });
  }

  /*
    ⚠️ **成立した返金だけ。** 申請中を引くと、返っていないお金を返した
       ことにしてしまう。
  */
  it('成立していない返金を数えない', async () => {
    const orderId = await seedOrder({ paidAt: new Date('2026-08-10T00:00:00.000Z') });
    await seedRefund({ orderId, status: 'requested', settledAt: null });
    // ⚠️ 失敗した返金に成立時刻は入らない（DB の CHECK が守っている）。
    await seedRefund({ orderId, status: 'failed', settledAt: null });

    expect(await sales.aggregateRefunds(PERIOD)).toEqual([]);
  });

  /*
    ⚠️ **数えるのは成立した日。** 注文の支払日で数えると、一度締めて
       会計へ渡した月が、翌月の返金で書き換わる。
  */
  it('返金は成立した日で数える（注文の支払日ではない）', async () => {
    const orderId = await seedOrder({ paidAt: new Date('2026-08-05T00:00:00.000Z') });
    await seedRefund({
      orderId,
      status: 'succeeded',
      settledAt: new Date('2026-08-20T00:00:00.000Z'),
    });

    const rows = await sales.aggregateRefunds(PERIOD);
    expect(rows).toEqual([{ periodKey: '2026-08-20', refundCount: 1, refundedAmount: 12000 }]);
  });

  it('試し売りの返金を数えない', async () => {
    const fixture = await seedOrder({
      paidAt: new Date('2026-08-05T00:00:00.000Z'),
      source: 'STAGING_FIXTURE',
    });
    await seedRefund({
      orderId: fixture,
      status: 'succeeded',
      settledAt: new Date('2026-08-20T00:00:00.000Z'),
    });

    expect(await sales.aggregateRefunds(PERIOD)).toEqual([]);
  });
});

suite('作家さまの一覧', () => {
  /*
    ⚠️ **件数が掛け算にならないこと。** 作品数と注文数を同じ `JOIN` で
       数えると、互いの行数を掛けた値になる（扇形結合）。**2 と 3 で
       6 にならない**ことを、実物の DB で確かめる。
  */
  it('作品数と注文数が掛け算にならない', async () => {
    for (let i = 0; i < 2; i += 1) {
      await prisma.artwork.create({
        data: {
          slug: `slug-extra-${randomUUID()}`,
          title: `作品 ${String(i)}`,
          status: 'published',
          maxSupply: 5,
          creatorAccountId: creatorId,
        },
      });
    }
    for (let i = 0; i < 3; i += 1) {
      await seedOrder({ paidAt: new Date('2026-08-20T00:00:00.000Z') });
    }

    const rows = await creators.list({ limit: 10 });
    expect(rows).toHaveLength(1);
    // 最初の 1 件 + 追加の 2 件 = 3。⚠️ 3 × 3 = 9 にならないこと。
    expect(rows[0]?.artworkCount).toBe(3);
    expect(rows[0]?.orderCount).toBe(3);
    expect(rows[0]?.grossAmount).toBe(36000);
  });

  it('売上の無い作家さまも、作品があれば出る', async () => {
    const rows = await creators.list({ limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      displayName: '千ノ国 太郎',
      artworkCount: 1,
      orderCount: 0,
      grossAmount: 0,
      hasPayoutAccount: false,
    });
  });

  it('公開中の出品だけを数える', async () => {
    await prisma.listing.create({
      data: { artworkId, priceAmount: 3000, priceCurrency: 'JPY', status: 'draft' },
    });
    const rows = await creators.list({ limit: 10 });
    expect(rows[0]?.activeListingCount).toBe(0);
  });

  it('表示名で絞れる', async () => {
    expect(await creators.list({ limit: 10, keyword: '千ノ国' })).toHaveLength(1);
    expect(await creators.list({ limit: 10, keyword: '見つからない' })).toHaveLength(0);
  });

  it('作品を持たない会員は、作家さまの一覧に出ない', async () => {
    // 買っただけの方（`buyerId`）は作品を持たない。
    const rows = await creators.list({ limit: 10 });
    expect(rows.map((row) => row.accountId)).toEqual([creatorId]);
  });

  it('1 人を引ける。居なければ null', async () => {
    expect(await creators.find(creatorId)).toMatchObject({ artworkCount: 1 });
    expect(await creators.find(randomUUID())).toBeNull();
  });
});
