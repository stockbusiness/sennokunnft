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
 * 押さえている数（`reserved_count`）と、実際の仮引当の食い違いを見つける。
 *
 * ⚠️ **「まだ売れる枠」の数え違いは、どちらへずれても困る。** 多く数えて
 * いれば売れるはずの枠が売れず、少なく数えていれば売り越しになる。
 *
 * ⚠️ **偽の警報を出さないことが半分。** 赤が当たり前になると、本当の赤が
 * 埋もれる。決済待ち・決済済み未発行・発行済み・一部発行・解放済みの
 * どれでも鳴らないことを、ここで確かめる。
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

interface Seeded {
  readonly artworkId: string;
  readonly orderId: string;
  readonly orderLineId: string;
  readonly accountId: string;
}

/**
 * 注文 1 件と、その仮引当 1 件。
 *
 * @param reservedCount 作品に立てる押さえの数。⚠️ ずれを作るために、
 *   実態と違う値も渡せるようにしてある。
 */
async function seed(options: {
  quantity: number;
  reservationStatus: 'reserved' | 'consumed' | 'released';
  issuedEntitlements: number;
  reservedCount: number;
  issuedCount?: number;
}): Promise<Seeded> {
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
      title: '押さえの照合の試験の作品',
      maxSupply: 20,
      reservedCount: options.reservedCount,
      issuedCount: options.issuedCount ?? options.issuedEntitlements,
      status: 'published',
    },
  });
  const listing = await prisma.listing.create({
    data: { artworkId: artwork.id, priceAmount: PRICE, priceCurrency: 'JPY' },
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
      artworkId: artwork.id,
      artworkTitleSnapshot: '押さえの照合の試験の作品',
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
      artworkId: artwork.id,
      quantity: options.quantity,
      status: options.reservationStatus,
      expiresAt: new Date(NOW.getTime() + 3_600_000),
      ...(options.reservationStatus === 'consumed' ? { consumedAt: NOW } : {}),
      ...(options.reservationStatus === 'released' ? { releasedAt: NOW } : {}),
    },
  });
  for (let index = 0; index < options.issuedEntitlements; index += 1) {
    await prisma.entitlement.create({
      data: {
        orderId: order.id,
        orderLineId: line.id,
        artworkId: artwork.id,
        accountId,
        serialNo: index + 1,
        unitIndex: index,
        claimTokenHash: `sha256:${randomUUID()}`,
        status: 'issued',
      },
    });
  }
  return { artworkId: artwork.id, orderId: order.id, orderLineId: line.id, accountId };
}

async function drift(): Promise<readonly string[]> {
  return (await repo.consistency()).reservedCountDrift;
}

suite('押さえている数と仮引当の照合', () => {
  it('決済待ちの注文は鳴らない（reserved が数量ぶん押さえている）', async () => {
    const seeded = await seed({
      quantity: 2,
      reservationStatus: 'reserved',
      issuedEntitlements: 0,
      reservedCount: 2,
    });

    expect(await drift()).not.toContain(seeded.artworkId);
  });

  it('決済が済んで受取権をまだ発行していない注文は鳴らない', async () => {
    /*
      ⚠️ **ここが決定 A の肝。** 仮引当は `consumed` になっているが、
         押さえは `reserved_count` に残っているのが正しい姿。
         `reserved` だけを数える式にすると、ここで誤って鳴る。
    */
    const seeded = await seed({
      quantity: 2,
      reservationStatus: 'consumed',
      issuedEntitlements: 0,
      reservedCount: 2,
    });

    expect(await drift()).not.toContain(seeded.artworkId);
  });

  it('発行し終えた注文は鳴らない（押さえは issued へ移っている）', async () => {
    const seeded = await seed({
      quantity: 2,
      reservationStatus: 'consumed',
      issuedEntitlements: 2,
      reservedCount: 0,
    });

    expect(await drift()).not.toContain(seeded.artworkId);
  });

  it('一部だけ発行済みの注文は鳴らない（残りぶんだけ押さえている）', async () => {
    const seeded = await seed({
      quantity: 3,
      reservationStatus: 'consumed',
      issuedEntitlements: 1,
      reservedCount: 2,
    });

    expect(await drift()).not.toContain(seeded.artworkId);
  });

  it('解放済みの仮引当は鳴らない（押さえは 0）', async () => {
    const seeded = await seed({
      quantity: 2,
      reservationStatus: 'released',
      issuedEntitlements: 0,
      reservedCount: 0,
    });

    expect(await drift()).not.toContain(seeded.artworkId);
  });

  it('多く数えていれば見つかる（売れるはずの枠が売れない）', async () => {
    const seeded = await seed({
      quantity: 1,
      reservationStatus: 'reserved',
      issuedEntitlements: 0,
      reservedCount: 5,
    });

    expect(await drift()).toContain(seeded.artworkId);
  });

  it('少なく数えていれば見つかる（売り越しになる）', async () => {
    const seeded = await seed({
      quantity: 2,
      reservationStatus: 'consumed',
      issuedEntitlements: 0,
      reservedCount: 0,
    });

    expect(await drift()).toContain(seeded.artworkId);
  });

  it('発行済みが数量を上回っていても、期待値を押し上げない', async () => {
    /*
      ⚠️ **二重発行で数が壊れている作品。** 期待値が負に振れると
         `reserved_count` が正しく見えてしまう。0 で止める。
    */
    const seeded = await seed({
      quantity: 1,
      reservationStatus: 'consumed',
      issuedEntitlements: 3,
      reservedCount: 0,
      issuedCount: 3,
    });

    expect(await drift()).not.toContain(seeded.artworkId);
  });

  it('仮引当がまったく無い作品は、押さえが 0 でなければ見つかる', async () => {
    const creatorAccountId = randomUUID();
    await prisma.account.create({
      data: { id: creatorAccountId, authProvider: 'fake', authSubject: creatorAccountId },
    });
    const artwork = await prisma.artwork.create({
      data: {
        creatorAccountId,
        slug: `artwork-${randomUUID()}`,
        title: '仮引当の無い作品',
        maxSupply: 10,
        reservedCount: 1,
        status: 'published',
      },
    });

    expect(await drift()).toContain(artwork.id);
  });

  it('売れていない作品は鳴らない（押さえも仮引当も 0）', async () => {
    const creatorAccountId = randomUUID();
    await prisma.account.create({
      data: { id: creatorAccountId, authProvider: 'fake', authSubject: creatorAccountId },
    });
    const artwork = await prisma.artwork.create({
      data: {
        creatorAccountId,
        slug: `artwork-${randomUUID()}`,
        title: 'まだ売れていない作品',
        maxSupply: 10,
        status: 'published',
      },
    });

    expect(await drift()).not.toContain(artwork.id);
  });
});
