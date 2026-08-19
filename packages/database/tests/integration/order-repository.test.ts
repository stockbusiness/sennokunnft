import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { CreateOrderCommand } from '@sengoku/domain';
import type { PrismaClient } from '../../generated/client';
import { PrismaOrderRepository } from '../../src/repositories/order.repository';
import {
  createTestClient,
  integrationTestsAvailable,
  resetDatabase,
  violatesConstraint,
} from '../helpers/database';

/**
 * 注文リポジトリを実 PostgreSQL に対して確かめる。
 *
 * ⚠️ **ここでしか確かめられないことがある。** 行ロック・条件付き更新・
 * 一意制約は、単一スレッドの Fake では再現できない。同時に走った 2 本が
 * 最後の 1 枠をどう分けるかは、実際に 2 本走らせないと分からない。
 */
const enabled = integrationTestsAvailable();
const suite = enabled ? describe : describe.skip;

let prisma: PrismaClient;
let repo: PrismaOrderRepository;

const NOW = new Date('2026-08-19T00:00:00.000Z');
const EXPIRES_AT = new Date('2026-08-19T00:30:00.000Z');

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

interface Seeded {
  readonly accountId: string;
  readonly creatorAccountId: string;
  readonly artworkId: string;
  readonly listingId: string;
}

async function seed(maxSupply = 5): Promise<Seeded> {
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
    data: { artworkId: artwork.id, priceAmount: 3000, priceCurrency: 'JPY', status: 'active' },
  });
  return { accountId, creatorAccountId, artworkId: artwork.id, listingId: listing.id };
}

function command(seeded: Seeded, overrides: Partial<CreateOrderCommand> = {}): CreateOrderCommand {
  return {
    orderId: randomUUID(),
    orderNumber: `SNK-20260819-${randomUUID().slice(0, 8).toUpperCase()}`,
    accountId: seeded.accountId,
    commonUserId: null,
    creatorAccountId: seeded.creatorAccountId,
    idempotencyKey: randomUUID(),
    // 規約が未公開の配備を模す。注文は止まらない（`UD-126`）。
    termsVersionId: null,
    termsVersion: null,
    currency: 'JPY',
    amounts: {
      subtotalAmount: 3000,
      discountAmount: 0,
      totalAmount: 3000,
      platformFeeRateBps: 0,
      platformFeeAmount: 0,
      creatorAmount: 3000,
    },
    orderStatus: 'pending',
    paymentStatus: 'not_started',
    fulfillmentStatus: 'not_started',
    refundStatus: 'none',
    item: {
      id: randomUUID(),
      listingId: seeded.listingId,
      artworkId: seeded.artworkId,
      creatorAccountId: seeded.creatorAccountId,
      titleSnapshot: '天下布武の陣羽織',
      unitPriceAmount: 3000,
      unitPriceCurrency: 'JPY',
      quantity: 1,
      totalAmount: 3000,
    },
    reservationId: randomUUID(),
    reservationExpiresAt: EXPIRES_AT,
    quantity: 1,
    now: NOW,
    ...overrides,
  };
}

suite('注文の作成と在庫の仮引当', () => {
  it('注文・明細・予約を作り、在庫を押さえる', async () => {
    const seeded = await seed();
    const result = await repo.createWithReservation(command(seeded));

    expect(result.ok).toBe(true);
    const artwork = await prisma.artwork.findUniqueOrThrow({ where: { id: seeded.artworkId } });
    expect(artwork.reservedCount).toBe(1);
    expect(await prisma.inventoryReservation.count()).toBe(1);
    expect(await prisma.orderLine.count()).toBe(1);
  });

  it('在庫を超える注文を拒否する', async () => {
    const seeded = await seed(1);
    await repo.createWithReservation(command(seeded));
    const second = await repo.createWithReservation(command(seeded));

    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe('INSUFFICIENT_SUPPLY');
    }
    // ⚠️ 失敗した注文の行が残っていないこと。残ると、買えていない注文が
    //    「お支払い待ち」として利用者の画面に出る。
    expect(await prisma.order.count()).toBe(1);
  });

  it('最後の 1 枠へ同時に来ても、成功するのは 1 件だけ', async () => {
    // ⚠️ **この試験が本丸。** 行ロックが効いていないと両方通り、
    //    同じ 1 枠が 2 人に売れる。
    const seeded = await seed(1);
    const results = await Promise.all([
      repo.createWithReservation(command(seeded)),
      repo.createWithReservation(command(seeded)),
      repo.createWithReservation(command(seeded)),
    ]);

    const created = results.filter((result) => result.ok && result.value.kind === 'created');
    expect(created).toHaveLength(1);
    const artwork = await prisma.artwork.findUniqueOrThrow({ where: { id: seeded.artworkId } });
    expect(artwork.reservedCount).toBe(1);
  });

  it('同じ冪等キー・同じ商品なら、最初の注文を返す', async () => {
    const seeded = await seed();
    const idempotencyKey = randomUUID();
    const first = await repo.createWithReservation(command(seeded, { idempotencyKey }));
    const second = await repo.createWithReservation(command(seeded, { idempotencyKey }));

    expect(first.ok && first.value.kind).toBe('created');
    expect(second.ok && second.value.kind).toBe('reused');
    if (first.ok && first.value.kind === 'created' && second.ok && second.value.kind === 'reused') {
      expect(second.value.order.id).toBe(first.value.order.id);
    }
    // ⚠️ 在庫は 1 つしか減らない。
    const artwork = await prisma.artwork.findUniqueOrThrow({ where: { id: seeded.artworkId } });
    expect(artwork.reservedCount).toBe(1);
  });

  it('同じ冪等キーで別の商品なら conflict を返す', async () => {
    const seeded = await seed();
    const other = await prisma.listing.create({
      data: {
        artworkId: seeded.artworkId,
        priceAmount: 4000,
        priceCurrency: 'JPY',
        status: 'draft',
      },
    });
    const idempotencyKey = randomUUID();
    await repo.createWithReservation(command(seeded, { idempotencyKey }));
    const conflict = await repo.createWithReservation(
      command(seeded, {
        idempotencyKey,
        item: { ...command(seeded).item, listingId: other.id },
      }),
    );

    expect(conflict.ok && conflict.value.kind).toBe('conflict');
  });

  it('同じ冪等キーの同時要求でも注文は 1 件だけ', async () => {
    const seeded = await seed();
    const idempotencyKey = randomUUID();
    await Promise.all([
      repo.createWithReservation(command(seeded, { idempotencyKey })),
      repo.createWithReservation(command(seeded, { idempotencyKey })),
    ]);

    expect(await prisma.order.count()).toBe(1);
    const artwork = await prisma.artwork.findUniqueOrThrow({ where: { id: seeded.artworkId } });
    expect(artwork.reservedCount).toBe(1);
  });
});

suite('期限切れ予約の解放', () => {
  const AFTER_EXPIRY = new Date('2026-08-19T01:00:00.000Z');

  it('期限内の予約は解放しない', async () => {
    const seeded = await seed();
    await repo.createWithReservation(command(seeded));

    const released = await repo.releaseExpiredReservations(NOW, 100);

    expect(released).toHaveLength(0);
  });

  it('期限切れの予約を解放し、在庫を戻し、注文を expired にする', async () => {
    const seeded = await seed();
    await repo.createWithReservation(command(seeded));

    const released = await repo.releaseExpiredReservations(AFTER_EXPIRY, 100);

    expect(released).toHaveLength(1);
    const artwork = await prisma.artwork.findUniqueOrThrow({ where: { id: seeded.artworkId } });
    expect(artwork.reservedCount).toBe(0);
    const order = await prisma.order.findFirstOrThrow();
    expect(order.status).toBe('expired');
  });

  it('もう一度走らせても二重に解放しない', async () => {
    // ⚠️ 二重に戻ると、在庫が実際より多く見え、売れない物が売れる。
    const seeded = await seed();
    await repo.createWithReservation(command(seeded));

    await repo.releaseExpiredReservations(AFTER_EXPIRY, 100);
    const second = await repo.releaseExpiredReservations(AFTER_EXPIRY, 100);

    expect(second).toHaveLength(0);
    const artwork = await prisma.artwork.findUniqueOrThrow({ where: { id: seeded.artworkId } });
    expect(artwork.reservedCount).toBe(0);
  });

  it('同時に走らせても、1 件の予約は 1 回しか解放されない', async () => {
    const seeded = await seed(3);
    await repo.createWithReservation(command(seeded));
    await repo.createWithReservation(command(seeded));

    const [left, right] = await Promise.all([
      repo.releaseExpiredReservations(AFTER_EXPIRY, 100),
      repo.releaseExpiredReservations(AFTER_EXPIRY, 100),
    ]);

    expect((left?.length ?? 0) + (right?.length ?? 0)).toBe(2);
    const artwork = await prisma.artwork.findUniqueOrThrow({ where: { id: seeded.artworkId } });
    expect(artwork.reservedCount).toBe(0);
  });

  it('1 回の処理件数を上限で区切れる', async () => {
    const seeded = await seed(3);
    await repo.createWithReservation(command(seeded));
    await repo.createWithReservation(command(seeded));
    await repo.createWithReservation(command(seeded));

    const first = await repo.releaseExpiredReservations(AFTER_EXPIRY, 2);
    expect(first).toHaveLength(2);
    const second = await repo.releaseExpiredReservations(AFTER_EXPIRY, 2);
    expect(second).toHaveLength(1);
  });

  it('解放したあと、同じ枠をもう一度買える', async () => {
    // 部分 UNIQUE 索引が `reserved` に限っていることの確認。
    const seeded = await seed(1);
    await repo.createWithReservation(command(seeded));
    await repo.releaseExpiredReservations(AFTER_EXPIRY, 100);

    const retry = await repo.createWithReservation(command(seeded));

    expect(retry.ok && retry.value.kind).toBe('created');
  });

  /*
    注文時点の規約の版（`UD-126`）。
    ⚠️ **片方だけ入った行を作らせない。** ID だけ・番号だけの行は、
       「どの版だったか」を答えられないのに答えられるように見える。
  */
  it('規約の版は、ID と番号の両方が揃っていなければ入らない', async () => {
    const seeded = await seed(1);
    const created = await repo.createWithReservation(command(seeded));
    if (!created.ok || created.value.kind !== 'created') {
      throw new Error('order not created');
    }

    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "orders" SET "terms_version" = 3 WHERE id = $1::uuid`,
        created.value.order.id,
      ),
    ).rejects.toSatisfy((error: unknown) => violatesConstraint(error, 'orders_terms_version_pair'));
  });
});
