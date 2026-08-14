import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createOrder, type Artwork, type Listing } from '@sengoku/domain';
import type { PrismaClient } from '../../generated/client';
import { PrismaOrderRepository } from '../../src/repositories/order.repository';
import {
  createTestClient,
  integrationTestsAvailable,
  resetDatabase,
  violatesConstraint,
} from '../helpers/database';

/**
 * 注文の永続化を実 PostgreSQL に対して確かめる。
 *
 * ⚠️ **ここを Fake で済ませない。**
 * 確かめたいのは「同時に来た注文で売り越さない」ことで、
 * それを保証しているのは行ロックと CHECK 制約。
 * メモリ実装で確かめても意味がない。
 */
const enabled = integrationTestsAvailable();
const suite = enabled ? describe : describe.skip;

let prisma: PrismaClient;
let repo: PrismaOrderRepository;

const NOW = new Date('2026-08-14T00:00:00.000Z');

beforeAll(async () => {
  if (!enabled) return;
  prisma = createTestClient();
  await prisma.$connect();
  repo = new PrismaOrderRepository(prisma);
});

afterAll(async () => {
  if (!enabled) return;
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!enabled) return;
  await resetDatabase(prisma);
});

/** 購入できる作品と出品を 1 組つくる。 */
async function seed(maxSupply = 3): Promise<{ accountId: string; listingId: string }> {
  const accountId = randomUUID();
  await prisma.account.create({
    data: { id: accountId, authProvider: 'fake', authSubject: accountId },
  });
  const artwork = await prisma.artwork.create({
    data: {
      slug: `artwork-${randomUUID()}`,
      title: '天下布武の陣羽織',
      description: '',
      maxSupply,
      status: 'published',
    },
  });
  const listing = await prisma.listing.create({
    data: {
      artworkId: artwork.id,
      priceAmount: 1000,
      priceCurrency: 'JPY',
      maxQuantityPerOrder: 5,
      status: 'active',
    },
  });
  return { accountId, listingId: listing.id };
}

/** 目的の出品に対する注文を組み立てる。 */
async function draftFor(accountId: string, listingId: string, quantity = 1) {
  const target = await repo.findPurchaseTarget(listingId);
  if (target === null) throw new Error('出品が見つかりません');
  const artwork = {
    id: target.artwork.id,
    slug: target.artwork.slug,
    title: target.artwork.title,
    description: '',
    imageKey: null,
    imageContentType: null,
    imageByteSize: null,
    maxSupply: target.artwork.counters.maxSupply,
    reservedCount: target.artwork.counters.reservedCount,
    issuedCount: target.artwork.counters.issuedCount,
    status: target.artwork.status,
  } as unknown as Artwork;
  const listing: Listing = {
    id: target.listing.id,
    artworkId: target.listing.artworkId,
    price: { amountMinor: target.listing.priceAmount, currency: target.listing.priceCurrency },
    maxQuantityPerOrder: target.listing.maxQuantityPerOrder,
    status: target.listing.status as Listing['status'],
    startsAt: target.listing.startsAt,
    endsAt: target.listing.endsAt,
    displayOrder: target.listing.displayOrder,
  };
  const result = createOrder({
    accountId,
    listing,
    artwork,
    counters: target.artwork.counters,
    quantity,
    now: NOW,
  });
  if (!result.ok) throw new Error(`注文を組み立てられません: ${result.error.code}`);
  return result.value;
}

suite('注文の保存と在庫の仮引当', () => {
  it('注文を保存し、在庫を押さえる', async () => {
    const { accountId, listingId } = await seed();
    const draft = await draftFor(accountId, listingId, 2);
    const order = await repo.createWithReservation({
      draft,
      idempotencyKey: randomUUID(),
      quantity: 2,
    });
    expect(order.totalAmount).toBe(2000);
    expect(order.status).toBe('pending');

    const target = await repo.findPurchaseTarget(listingId);
    expect(target?.artwork.counters.reservedCount).toBe(2);
  });

  it('明細に注文時点の作品名と単価が残る', async () => {
    const { accountId, listingId } = await seed();
    const draft = await draftFor(accountId, listingId);
    const order = await repo.createWithReservation({
      draft,
      idempotencyKey: randomUUID(),
      quantity: 1,
    });
    const lines = await prisma.orderLine.findMany({ where: { orderId: order.id } });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.artworkTitleSnapshot).toBe('天下布武の陣羽織');
    expect(lines[0]?.unitPriceAmount).toBe(1000);
  });

  it('同じ冪等キーの再送では作り直さない', async () => {
    const { accountId, listingId } = await seed();
    const key = randomUUID();
    const first = await repo.createWithReservation({
      draft: await draftFor(accountId, listingId),
      idempotencyKey: key,
      quantity: 1,
    });
    const second = await repo.createWithReservation({
      draft: await draftFor(accountId, listingId),
      idempotencyKey: key,
      quantity: 1,
    });
    expect(second.id).toBe(first.id);

    // ⚠️ 在庫も二重に押さえていないこと。
    const target = await repo.findPurchaseTarget(listingId);
    expect(target?.artwork.counters.reservedCount).toBe(1);
  });

  it('同時に 5 本注文しても、上限を超えて押さえない', async () => {
    // ⚠️ 行ロックが効いていなければ、5 本とも同じ残数を見て通ってしまう。
    const { accountId, listingId } = await seed(3);
    const drafts = await Promise.all(
      Array.from({ length: 5 }, () => draftFor(accountId, listingId)),
    );
    const results = await Promise.allSettled(
      drafts.map((draft) =>
        repo.createWithReservation({ draft, idempotencyKey: randomUUID(), quantity: 1 }),
      ),
    );
    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    expect(succeeded).toBeLessThanOrEqual(3);

    const target = await repo.findPurchaseTarget(listingId);
    const counters = target?.artwork.counters;
    expect(counters?.reservedCount).toBe(succeeded);
    // 最終防壁。押さえた数が上限を超えていない。
    expect((counters?.reservedCount ?? 0) + (counters?.issuedCount ?? 0)).toBeLessThanOrEqual(3);
  });

  it('上限を超える引当は CHECK 制約が拒否する', async () => {
    // 3 段目の防壁。ドメインと行ロックを迂回しても止まる。
    const { listingId } = await seed(2);
    const target = await repo.findPurchaseTarget(listingId);
    await expect(
      prisma.artwork.update({
        where: { id: target?.artwork.id },
        data: { reservedCount: 3 },
      }),
    ).rejects.toSatisfy((error) => violatesConstraint(error, 'artworks_supply_within_max'));
  });

  it('知らない出品IDは null', async () => {
    expect(await repo.findPurchaseTarget(randomUUID())).toBeNull();
  });
});
