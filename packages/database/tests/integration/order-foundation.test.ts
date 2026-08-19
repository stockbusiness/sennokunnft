import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../../generated/client';
import {
  createTestClient,
  integrationTestsAvailable,
  orderLineSeedFields,
  orderSeedFields,
  resetDatabase,
  violatesConstraint,
  violatesUniqueConstraint,
} from '../helpers/database';

/**
 * 決済 Phase P0・P1 で足した DB 制約が、実際に効くことを確かめる。
 *
 * ⚠️ ここはドメインの試験ではない。**アプリ側の判定に穴が開いたときに
 * 残る最後の砦**が本当に立っているかを見る。ドメイン側の同じ規則は
 * `@sengoku/domain` の単体試験が別に持っている。二重に持つのは重複ではなく、
 * 片方が抜けたときにもう片方が気づくための構えである。
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

interface Seeded {
  readonly accountId: string;
  readonly creatorAccountId: string;
  readonly artworkId: string;
  readonly listingId: string;
}

async function seed(): Promise<Seeded> {
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
      maxSupply: 10,
      status: 'published',
    },
  });
  const listing = await prisma.listing.create({
    data: { artworkId: artwork.id, priceAmount: 3000, priceCurrency: 'JPY' },
  });
  return { accountId, creatorAccountId, artworkId: artwork.id, listingId: listing.id };
}

async function createOrderRow(
  seeded: Seeded,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const order = await prisma.order.create({
    data: {
      accountId: seeded.accountId,
      totalAmount: 3000,
      totalCurrency: 'JPY',
      idempotencyKey: randomUUID(),
      ...orderSeedFields({ creatorAccountId: seeded.creatorAccountId, totalAmount: 3000 }),
      ...overrides,
    },
  });
  return order.id;
}

suite('注文の金額の CHECK 制約', () => {
  it('合計が 小計 − 値引 と一致しない行を作れない', async () => {
    // ⚠️ 内訳と合計が食い違う注文は、返金でも会計でも判断の拠り所が消える。
    const seeded = await seed();
    await expect(
      createOrderRow(seeded, { totalAmount: 2000, creatorAmount: 2000 }),
    ).rejects.toSatisfy((error) => violatesConstraint(error, 'orders_total_matches_subtotal'));
  });

  it('手数料 + クリエイター配分 が合計と一致しない行を作れない', async () => {
    const seeded = await seed();
    await expect(
      createOrderRow(seeded, { platformFeeAmount: 300, creatorAmount: 3000 }),
    ).rejects.toSatisfy((error) => violatesConstraint(error, 'orders_split_matches_total'));
  });

  it('負の金額を拒否する', async () => {
    const seeded = await seed();
    await expect(
      createOrderRow(seeded, {
        subtotalAmount: -1,
        totalAmount: -1,
        creatorAmount: -1,
      }),
    ).rejects.toSatisfy((error) => violatesConstraint(error, 'orders_amounts_non_negative'));
  });

  it('100% を超える手数料率を拒否する', async () => {
    // bps（1/100 %）なので上限は 10000。率を小数で持たない。
    const seeded = await seed();
    await expect(
      createOrderRow(seeded, { platformFeeRateBps: 10_001 }),
    ).rejects.toSatisfy((error) => violatesConstraint(error, 'orders_fee_rate_range'));
  });

  it('知らない決済状態を拒否する', async () => {
    const seeded = await seed();
    await expect(
      createOrderRow(seeded, { paymentStatus: 'looks_ok' }),
    ).rejects.toSatisfy((error) => violatesConstraint(error, 'orders_payment_status_known'));
  });

  it('決済成功なのに支払時刻の無い行を作れない', async () => {
    const seeded = await seed();
    await expect(
      createOrderRow(seeded, { paymentStatus: 'succeeded' }),
    ).rejects.toSatisfy((error) => violatesConstraint(error, 'orders_paid_has_time'));
  });

  it('paid なのに支払時刻の無い行を作れない', async () => {
    // 管理画面が読むのは `paid_at`。注文側の状態だけ進めても空にさせない。
    const seeded = await seed();
    await expect(
      createOrderRow(seeded, { status: 'paid' }),
    ).rejects.toSatisfy((error) => violatesConstraint(error, 'orders_paid_has_time'));
  });

  it('注文番号は重複できない', async () => {
    const seeded = await seed();
    const orderNumber = `TEST-${randomUUID()}`;
    await createOrderRow(seeded, { orderNumber });
    await expect(createOrderRow(seeded, { orderNumber })).rejects.toSatisfy((error) =>
      violatesUniqueConstraint(error),
    );
  });

  it('同じ購入者の同じ冪等キーで 2 件目を作れない', async () => {
    // ⚠️ アプリの重複チェックではなく、ここが二重注文を止める。
    const seeded = await seed();
    const idempotencyKey = randomUUID();
    await createOrderRow(seeded, { idempotencyKey });
    await expect(createOrderRow(seeded, { idempotencyKey })).rejects.toSatisfy((error) =>
      violatesUniqueConstraint(error),
    );
  });
});

suite('注文明細の CHECK / UNIQUE 制約', () => {
  async function createLine(
    seeded: Seeded,
    orderId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const line = await prisma.orderLine.create({
      data: {
        orderId,
        listingId: seeded.listingId,
        artworkId: seeded.artworkId,
        artworkTitleSnapshot: '天下布武の陣羽織',
        unitPriceAmount: 3000,
        unitPriceCurrency: 'JPY',
        quantity: 1,
        ...orderLineSeedFields({
          creatorAccountId: seeded.creatorAccountId,
          unitPriceAmount: 3000,
          quantity: 1,
        }),
        ...overrides,
      },
    });
    return line.id;
  }

  it('1 注文に明細を 2 本入れられない', async () => {
    // ⚠️ 指示書 §5.2「1 注文 = 1 作品」。複数クリエイターのカートを
    //    作らせないための最後の砦。
    const seeded = await seed();
    const orderId = await createOrderRow(seeded);
    await createLine(seeded, orderId);
    await expect(createLine(seeded, orderId)).rejects.toSatisfy((error) =>
      violatesUniqueConstraint(error),
    );
  });

  it('単価 × 数量 と合計が食い違う明細を作れない', async () => {
    const seeded = await seed();
    const orderId = await createOrderRow(seeded);
    await expect(
      createLine(seeded, orderId, { quantity: 2, totalAmount: 3000 }),
    ).rejects.toSatisfy((error) => violatesConstraint(error, 'order_lines_total_matches_unit_price'));
  });
});

suite('在庫の仮引当の制約', () => {
  const EXPIRES_AT = new Date('2026-08-19T12:00:00.000Z');

  async function createReservation(
    seeded: Seeded,
    orderId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const row = await prisma.inventoryReservation.create({
      data: {
        orderId,
        listingId: seeded.listingId,
        artworkId: seeded.artworkId,
        quantity: 1,
        expiresAt: EXPIRES_AT,
        ...overrides,
      },
    });
    return row.id;
  }

  it('1 注文に有効な予約は 1 件だけ', async () => {
    // ⚠️ 2 件あると、解放が 1 件ぶんしか行われず在庫が戻らない。
    const seeded = await seed();
    const orderId = await createOrderRow(seeded);
    await createReservation(seeded, orderId);
    await expect(createReservation(seeded, orderId)).rejects.toSatisfy((error) =>
      violatesUniqueConstraint(error),
    );
  });

  it('解放済みの予約が残っていても、新しい予約を作れる', async () => {
    // 部分 UNIQUE 索引が `status = 'reserved'` に限っているため。
    // ここが効いていないと、期限切れのあと再購入できなくなる。
    const seeded = await seed();
    const orderId = await createOrderRow(seeded);
    const first = await createReservation(seeded, orderId);
    await prisma.inventoryReservation.update({
      where: { id: first },
      data: { status: 'released', releasedAt: EXPIRES_AT },
    });
    await expect(createReservation(seeded, orderId)).resolves.toBeTypeOf('string');
  });

  it('知らない状態を拒否する', async () => {
    const seeded = await seed();
    const orderId = await createOrderRow(seeded);
    await expect(
      createReservation(seeded, orderId, { status: 'maybe' }),
    ).rejects.toSatisfy((error) =>
      violatesConstraint(error, 'inventory_reservations_status_known'),
    );
  });

  it('released なのに解放時刻の無い行を作れない', async () => {
    const seeded = await seed();
    const orderId = await createOrderRow(seeded);
    await expect(
      createReservation(seeded, orderId, { status: 'released' }),
    ).rejects.toSatisfy((error) =>
      violatesConstraint(error, 'inventory_reservations_released_has_time'),
    );
  });

  it('数量 0 の予約を拒否する', async () => {
    const seeded = await seed();
    const orderId = await createOrderRow(seeded);
    await expect(
      createReservation(seeded, orderId, { quantity: 0 }),
    ).rejects.toSatisfy((error) =>
      violatesConstraint(error, 'inventory_reservations_quantity_positive'),
    );
  });

  it('予約の残っている注文は消せない', async () => {
    // ⚠️ 注文と決済のデータを物理削除させない（指示書 §9.3）。
    const seeded = await seed();
    const orderId = await createOrderRow(seeded);
    await createReservation(seeded, orderId);
    await expect(prisma.order.delete({ where: { id: orderId } })).rejects.toThrow();
  });
});

suite('決済行の CHECK 制約', () => {
  it('succeeded なのに支払時刻の無い行を作れない', async () => {
    // ⚠️ 決済の真の状態は外部にある。時刻の無い成功を記録すると、
    //    照合のときにどちらが正しいか決められなくなる。
    const seeded = await seed();
    const orderId = await createOrderRow(seeded);
    await expect(
      prisma.payment.create({
        data: {
          orderId,
          provider: 'fake',
          status: 'succeeded',
          amount: 3000,
          currency: 'JPY',
        },
      }),
    ).rejects.toSatisfy((error) => violatesConstraint(error, 'payments_succeeded_has_time'));
  });
});
