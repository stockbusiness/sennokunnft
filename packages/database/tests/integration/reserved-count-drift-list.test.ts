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
} from '../helpers/database';

/**
 * 押さえがずれた作品の一覧（`ADMIN_OPERATIONS_GAP.md` §I）。
 *
 * ⚠️ **数を返すところまでがここの担当。** あるべき値の計算はドメインが
 * 持つ（`buildReservedCountDriftViews`）。ここでは素の数と、
 * **どの注文が関わっているか**が正しく出ることを見る。
 */
const enabled = integrationTestsAvailable();
const suite = enabled ? describe : describe.skip;

const NOW = new Date('2026-08-20T00:00:00.000Z');
const PRICE = 3000;

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

async function seedArtwork(reservedCount: number, issuedCount = 0): Promise<string> {
  const creatorAccountId = randomUUID();
  await prisma.account.create({
    data: { id: creatorAccountId, authProvider: 'fake', authSubject: creatorAccountId },
  });
  const artwork = await prisma.artwork.create({
    data: {
      creatorAccountId,
      slug: `artwork-${randomUUID()}`,
      title: 'ずれの一覧の試験の作品',
      maxSupply: 20,
      reservedCount,
      issuedCount,
      status: 'published',
    },
  });
  return artwork.id;
}

async function seedOrderWithReservation(options: {
  artworkId: string;
  quantity: number;
  status: 'reserved' | 'consumed' | 'released';
  entitlements: number;
}): Promise<{ orderId: string; orderNumber: string }> {
  const accountId = randomUUID();
  const creatorAccountId = randomUUID();
  await prisma.account.createMany({
    data: [
      { id: accountId, authProvider: 'fake', authSubject: accountId },
      { id: creatorAccountId, authProvider: 'fake', authSubject: creatorAccountId },
    ],
  });
  const listing = await prisma.listing.create({
    data: { artworkId: options.artworkId, priceAmount: PRICE, priceCurrency: 'JPY' },
  });
  const total = PRICE * options.quantity;
  const order = await prisma.order.create({
    data: {
      accountId,
      totalAmount: total,
      totalCurrency: 'JPY',
      idempotencyKey: randomUUID(),
      status: 'paid',
      paymentStatus: 'succeeded',
      paidAt: NOW,
      ...orderSeedFields({ creatorAccountId, totalAmount: total }),
    },
  });
  const line = await prisma.orderLine.create({
    data: {
      orderId: order.id,
      listingId: listing.id,
      artworkId: options.artworkId,
      artworkTitleSnapshot: 'ずれの一覧の試験の作品',
      unitPriceAmount: PRICE,
      unitPriceCurrency: 'JPY',
      quantity: options.quantity,
      ...orderLineSeedFields({
        creatorAccountId,
        unitPriceAmount: PRICE,
        quantity: options.quantity,
      }),
    },
  });
  await prisma.inventoryReservation.create({
    data: {
      orderId: order.id,
      listingId: listing.id,
      artworkId: options.artworkId,
      quantity: options.quantity,
      status: options.status,
      expiresAt: new Date(NOW.getTime() + 3_600_000),
      ...(options.status === 'consumed' ? { consumedAt: NOW } : {}),
      ...(options.status === 'released' ? { releasedAt: NOW } : {}),
    },
  });
  for (let index = 0; index < options.entitlements; index += 1) {
    await prisma.entitlement.create({
      data: {
        orderId: order.id,
        orderLineId: line.id,
        artworkId: options.artworkId,
        accountId,
        serialNo: index + 1,
        unitIndex: index,
        claimTokenHash: `sha256:${randomUUID()}`,
        status: 'issued',
      },
    });
  }
  return { orderId: order.id, orderNumber: order.orderNumber };
}

suite('押さえがずれた作品の一覧', () => {
  it('合っている作品は返さない', async () => {
    const artworkId = await seedArtwork(2);
    await seedOrderWithReservation({ artworkId, quantity: 2, status: 'reserved', entitlements: 0 });

    const page = await repo.reservedCountDrift(50);

    expect(page.items).toEqual([]);
    expect(page.hasMore).toBe(false);
  });

  it('ずれた作品を、作品名と押さえの数つきで返す', async () => {
    const artworkId = await seedArtwork(5);
    await seedOrderWithReservation({ artworkId, quantity: 1, status: 'reserved', entitlements: 0 });

    const page = await repo.reservedCountDrift(50);

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      artworkId,
      artworkTitle: 'ずれの一覧の試験の作品',
      reservedCount: 5,
    });
  });

  it('関わっている注文を、注文番号と数つきで返す', async () => {
    /*
      ⚠️ **ここがこの一覧の値打ち。** 作品の識別子だけでは、どこを見れば
         よいのか分からない。
    */
    const artworkId = await seedArtwork(9);
    const seeded = await seedOrderWithReservation({
      artworkId,
      quantity: 3,
      status: 'consumed',
      entitlements: 1,
    });

    const page = await repo.reservedCountDrift(50);

    expect(page.items[0]?.orders).toEqual([
      {
        orderId: seeded.orderId,
        orderNumber: seeded.orderNumber,
        orderStatus: 'paid',
        heldQuantity: 3,
        issuedCount: 1,
      },
    ]);
  });

  it('解放済みの仮引当は数に入れない', async () => {
    const artworkId = await seedArtwork(2);
    await seedOrderWithReservation({ artworkId, quantity: 2, status: 'released', entitlements: 0 });

    const page = await repo.reservedCountDrift(50);

    // 押さえ 2・あるべき 0 なのでずれとして出る。⚠️ 内訳に解放済みは載らない。
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.orders).toEqual([]);
  });

  it('仮引当がまったく無い作品も、押さえが立っていれば返す', async () => {
    const artworkId = await seedArtwork(1);

    const page = await repo.reservedCountDrift(50);

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.artworkId).toBe(artworkId);
    expect(page.items[0]?.orders).toEqual([]);
  });

  it('上限で切ったことを隠さない', async () => {
    await seedArtwork(1);
    await seedArtwork(1);
    await seedArtwork(1);

    const page = await repo.reservedCountDrift(2);

    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(true);
  });

  it('ちょうど上限のときは、切っていないと伝える', async () => {
    await seedArtwork(1);
    await seedArtwork(1);

    const page = await repo.reservedCountDrift(2);

    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(false);
  });

  it('ずれていない作品の注文は混ざらない', async () => {
    const drifted = await seedArtwork(5);
    await seedOrderWithReservation({
      artworkId: drifted,
      quantity: 1,
      status: 'reserved',
      entitlements: 0,
    });
    const healthy = await seedArtwork(2);
    await seedOrderWithReservation({
      artworkId: healthy,
      quantity: 2,
      status: 'reserved',
      entitlements: 0,
    });

    const page = await repo.reservedCountDrift(50);

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.artworkId).toBe(drifted);
  });
});
