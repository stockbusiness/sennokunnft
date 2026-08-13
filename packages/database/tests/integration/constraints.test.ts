import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../../generated/client';
import {
  createTestClient,
  integrationTestsAvailable,
  resetDatabase,
  violatesConstraint,
} from '../helpers/database';

/**
 * 実 PostgreSQL に対する制約の検証（TEST_STRATEGY.md §3.2 M-1/M-2、§3.3 S-4）。
 *
 * Phase 1 ではスキーマ上に制約が「書かれている」ことを静的に検査していた。
 * ここでは実際に「効く」ことを確かめる。
 * 書いてあるのに効いていない（マイグレーション漏れ）を検出するのが目的。
 */
const enabled = integrationTestsAvailable();
const suite = enabled ? describe : describe.skip;

let prisma: PrismaClient;

beforeAll(async () => {
  if (!enabled) return;
  prisma = createTestClient();
  await prisma.$connect();
});

afterAll(async () => {
  if (!enabled) return;
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!enabled) return;
  await resetDatabase(prisma);
});

async function seedArtwork(overrides: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await prisma.artwork.create({
    data: {
      id,
      slug: `artwork-${id.slice(0, 8)}`,
      title: 'テスト作品',
      maxSupply: 10,
      imageKey: 'images/test.png',
      status: 'published',
      ...overrides,
    },
  });
  return id;
}

suite('在庫の CHECK 制約（S-4: オーバーセルの最終防壁）', () => {
  it('上限ちょうどまでは更新できる', async () => {
    const id = await seedArtwork({ maxSupply: 10 });
    await prisma.artwork.update({
      where: { id },
      data: { reservedCount: 4, issuedCount: 6 },
    });
    const row = await prisma.artwork.findUniqueOrThrow({ where: { id } });
    expect(row.reservedCount + row.issuedCount).toBe(10);
  });

  it('上限を 1 超えると DB が拒否する', async () => {
    // アプリの行ロック実装に穴があっても、ここで止まる。
    const id = await seedArtwork({ maxSupply: 10 });
    await expect(
      prisma.artwork.update({ where: { id }, data: { reservedCount: 5, issuedCount: 6 } }),
    ).rejects.toSatisfy((error) => violatesConstraint(error, 'artworks_supply_within_max'));
  });

  it('作成時点で上限を超えていれば拒否する', async () => {
    await expect(seedArtwork({ maxSupply: 2, reservedCount: 2, issuedCount: 1 })).rejects.toSatisfy(
      (error) => violatesConstraint(error, 'artworks_supply_within_max'),
    );
  });

  it('負の在庫を拒否する', async () => {
    const id = await seedArtwork();
    await expect(
      prisma.artwork.update({ where: { id }, data: { reservedCount: -1 } }),
    ).rejects.toSatisfy((error) =>
      violatesConstraint(error, 'artworks_reserved_count_non_negative'),
    );
  });

  it('発行上限 0 の作品を作れない', async () => {
    await expect(seedArtwork({ maxSupply: 0 })).rejects.toSatisfy((error) =>
      violatesConstraint(error, 'artworks_max_supply_positive'),
    );
  });

  it('同時更新でも合計が上限を超えない', async () => {
    // 在庫 1 に対して 2 つの引当を同時に投げる。
    // アプリ側のロックがない状態でも、DB が少なくとも一方を落とす。
    const id = await seedArtwork({ maxSupply: 1 });
    const results = await Promise.allSettled([
      prisma.artwork.update({ where: { id }, data: { reservedCount: { increment: 1 } } }),
      prisma.artwork.update({ where: { id }, data: { reservedCount: { increment: 1 } } }),
    ]);

    const succeeded = results.filter((result) => result.status === 'fulfilled').length;
    expect(succeeded).toBe(1);

    const row = await prisma.artwork.findUniqueOrThrow({ where: { id } });
    expect(row.reservedCount + row.issuedCount).toBeLessThanOrEqual(row.maxSupply);
  });
});

suite('出品の CHECK 制約', () => {
  it('負の価格を拒否する', async () => {
    const artworkId = await seedArtwork();
    await expect(
      prisma.listing.create({
        data: { artworkId, priceAmount: -1, priceCurrency: 'JPY' },
      }),
    ).rejects.toSatisfy((error) => violatesConstraint(error, 'listings_price_non_negative'));
  });

  it('0 円の出品は作れる（無償配布の余地を残している）', async () => {
    const artworkId = await seedArtwork();
    const listing = await prisma.listing.create({
      data: { artworkId, priceAmount: 0, priceCurrency: 'JPY' },
    });
    expect(listing.priceAmount).toBe(0);
  });

  it('販売期間が逆転していれば拒否する', async () => {
    const artworkId = await seedArtwork();
    await expect(
      prisma.listing.create({
        data: {
          artworkId,
          priceAmount: 100,
          priceCurrency: 'JPY',
          startsAt: new Date('2026-07-01T00:00:00Z'),
          endsAt: new Date('2026-06-01T00:00:00Z'),
        },
      }),
    ).rejects.toSatisfy((error) => violatesConstraint(error, 'listings_period_ordered'));
  });

  it('1 注文あたりの数量上限に 0 を許さない', async () => {
    const artworkId = await seedArtwork();
    await expect(
      prisma.listing.create({
        data: { artworkId, priceAmount: 100, priceCurrency: 'JPY', maxQuantityPerOrder: 0 },
      }),
    ).rejects.toSatisfy((error) => violatesConstraint(error, 'listings_max_quantity_positive'));
  });
});

suite('一意制約', () => {
  it('slug は重複できない', async () => {
    await prisma.artwork.create({
      data: { slug: 'duplicate', title: 'A', maxSupply: 1 },
    });
    await expect(
      prisma.artwork.create({ data: { slug: 'duplicate', title: 'B', maxSupply: 1 } }),
    ).rejects.toSatisfy((error) => error instanceof Error);
  });
});

suite('返金額の CHECK 制約', () => {
  it('支払額を超える返金を拒否する', async () => {
    const accountId = randomUUID();
    await prisma.account.create({
      data: { id: accountId, authProvider: 'fake', authSubject: accountId },
    });
    const orderId = randomUUID();
    await prisma.order.create({
      data: {
        id: orderId,
        accountId,
        totalAmount: 1000,
        totalCurrency: 'JPY',
        idempotencyKey: randomUUID(),
      },
    });

    await expect(
      prisma.payment.create({
        data: {
          orderId,
          provider: 'fake',
          amount: 1000,
          currency: 'JPY',
          amountRefunded: 2000,
        },
      }),
    ).rejects.toSatisfy((error) => violatesConstraint(error, 'payments_refund_within_amount'));
  });
});

suite('受取権の CHECK 制約', () => {
  it('claimed なのに受取者が空の行を作れない', async () => {
    // 状態列と実データが食い違うと、監査でも復旧でも判断できなくなる。
    const accountId = randomUUID();
    await prisma.account.create({
      data: { id: accountId, authProvider: 'fake', authSubject: accountId },
    });
    const artworkId = await seedArtwork();
    const orderId = randomUUID();
    await prisma.order.create({
      data: {
        id: orderId,
        accountId,
        totalAmount: 1000,
        totalCurrency: 'JPY',
        idempotencyKey: randomUUID(),
      },
    });
    const listing = await prisma.listing.create({
      data: { artworkId, priceAmount: 1000, priceCurrency: 'JPY' },
    });
    const line = await prisma.orderLine.create({
      data: {
        orderId,
        listingId: listing.id,
        artworkId,
        artworkTitleSnapshot: 'テスト作品',
        unitPriceAmount: 1000,
        unitPriceCurrency: 'JPY',
        quantity: 1,
      },
    });

    await expect(
      prisma.entitlement.create({
        data: {
          orderId,
          orderLineId: line.id,
          artworkId,
          accountId,
          serialNo: 1,
          claimTokenHash: randomUUID(),
          status: 'claimed',
        },
      }),
    ).rejects.toSatisfy((error) =>
      violatesConstraint(error, 'entitlements_claimed_fields_present'),
    );
  });

  it('シリアル番号 0 を拒否する', async () => {
    const accountId = randomUUID();
    await prisma.account.create({
      data: { id: accountId, authProvider: 'fake', authSubject: accountId },
    });
    const artworkId = await seedArtwork();
    const orderId = randomUUID();
    await prisma.order.create({
      data: {
        id: orderId,
        accountId,
        totalAmount: 0,
        totalCurrency: 'JPY',
        idempotencyKey: randomUUID(),
      },
    });
    const listing = await prisma.listing.create({
      data: { artworkId, priceAmount: 0, priceCurrency: 'JPY' },
    });
    const line = await prisma.orderLine.create({
      data: {
        orderId,
        listingId: listing.id,
        artworkId,
        artworkTitleSnapshot: 'テスト作品',
        unitPriceAmount: 0,
        unitPriceCurrency: 'JPY',
        quantity: 1,
      },
    });

    await expect(
      prisma.entitlement.create({
        data: {
          orderId,
          orderLineId: line.id,
          artworkId,
          accountId,
          serialNo: 0,
          claimTokenHash: randomUUID(),
        },
      }),
    ).rejects.toSatisfy((error) => violatesConstraint(error, 'entitlements_serial_no_positive'));
  });
});
