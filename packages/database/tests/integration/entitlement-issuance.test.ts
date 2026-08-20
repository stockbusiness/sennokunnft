import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ISSUANCE_MAX_ATTEMPTS, type ClaimTokenPort } from '@sengoku/domain';
import type { PrismaClient } from '../../generated/client';
import { PrismaEntitlementIssuanceRepository } from '../../src/repositories/issuance.repository';
import {
  createTestClient,
  integrationTestsAvailable,
  orderLineSeedFields,
  orderSeedFields,
  resetDatabase,
  violatesUniqueConstraint,
} from '../helpers/database';

/**
 * 受取権の発行（P0-1）。
 *
 * ⚠️ ここはドメインの試験ではない。**同時に走ったときと、アプリの判定を
 * すり抜けたときに、DB が本当に止めるか**を見る。同じ規則の単体試験は
 * `@sengoku/domain` の `issuance.test.ts` が別に持っている。
 */
const enabled = integrationTestsAvailable();
const suite = enabled ? describe : describe.skip;

const NOW = new Date('2026-08-20T00:00:00.000Z');
const PRICE = 3000;

let prisma: PrismaClient;
let repo: PrismaEntitlementIssuanceRepository;

/** 受取トークンの発行器。⚠️ 平文は保存されないので、ここでは中身を問わない。 */
const tokens: ClaimTokenPort = {
  issue: () => {
    const token = randomUUID();
    return { token, tokenHash: `hash-${token}` };
  },
  hash: (token) => `hash-${token}`,
  matches: (token, expected) => `hash-${token}` === expected,
};

interface Seeded {
  readonly orderId: string;
  readonly orderLineId: string;
  readonly artworkId: string;
  readonly accountId: string;
}

beforeAll(async () => {
  if (!enabled) return;
  prisma = createTestClient();
  await prisma.$connect();
  repo = new PrismaEntitlementIssuanceRepository(prisma, tokens);
});

afterAll(async () => {
  if (!enabled) return;
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!enabled) return;
  await resetDatabase(prisma);
});

/**
 * 決済が済んだ注文を作る。
 *
 * ⚠️ **押さえた枠を `reservedCount` に残したまま置く**（決定 A）。決済が
 * 成功しただけでは枠を発行済みへ移さないので、この形が本番の姿である。
 */
async function seedPaidOrder(
  quantity: number,
  options: { maxSupply?: number; paymentStatus?: string } = {},
): Promise<Seeded> {
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
      title: '発行の試験の作品',
      maxSupply: options.maxSupply ?? 10,
      reservedCount: quantity,
      status: 'published',
    },
  });
  const listing = await prisma.listing.create({
    data: { artworkId: artwork.id, priceAmount: PRICE, priceCurrency: 'JPY' },
  });
  const paid = (options.paymentStatus ?? 'succeeded') === 'succeeded';
  const order = await prisma.order.create({
    data: {
      accountId,
      totalAmount: PRICE * quantity,
      totalCurrency: 'JPY',
      idempotencyKey: randomUUID(),
      status: paid ? 'paid' : 'pending',
      paymentStatus: options.paymentStatus ?? 'succeeded',
      // ⚠️ `succeeded` には支払い時刻が要る（既存の CHECK）。
      ...(paid ? { paidAt: NOW } : {}),
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
      artworkTitleSnapshot: '発行の試験の作品',
      unitPriceAmount: PRICE,
      unitPriceCurrency: 'JPY',
      quantity,
      ...orderLineSeedFields({ creatorAccountId, unitPriceAmount: PRICE, quantity }),
    },
  });
  return { orderId: order.id, orderLineId: line.id, artworkId: artwork.id, accountId };
}

function counters(artworkId: string) {
  return prisma.artwork.findUniqueOrThrow({
    where: { id: artworkId },
    select: { maxSupply: true, reservedCount: true, issuedCount: true },
  });
}

suite('数量ぶんを 1 枚ずつ作る', () => {
  it('数量 3 なら、異なるシリアル番号の 3 件ができる', async () => {
    const seeded = await seedPaidOrder(3);
    const result = await repo.issueForOrder(seeded.orderId, NOW);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.issued).toBe(3);

    const rows = await prisma.entitlement.findMany({
      where: { orderLineId: seeded.orderLineId },
      orderBy: { serialNo: 'asc' },
    });
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.serialNo)).toEqual([1, 2, 3]);
    // ⚠️ 明細の中の通し番号も 0 から連番。ここが冪等の鍵。
    expect(rows.map((row) => row.unitIndex)).toEqual([0, 1, 2]);
  });

  it('押さえた枠が発行済みへ移り、合計は変わらない', async () => {
    const seeded = await seedPaidOrder(3);
    const before = await counters(seeded.artworkId);
    await repo.issueForOrder(seeded.orderId, NOW);
    const after = await counters(seeded.artworkId);

    expect(after).toMatchObject({ reservedCount: 0, issuedCount: 3 });
    // ⚠️ 合計が増えたらオーバーセル。
    expect(after.reservedCount + after.issuedCount).toBe(before.reservedCount + before.issuedCount);
  });

  it('購入者と作品を受取権へ写す（Claim の本人照合に要る）', async () => {
    const seeded = await seedPaidOrder(1);
    await repo.issueForOrder(seeded.orderId, NOW);
    const row = await prisma.entitlement.findFirstOrThrow({
      where: { orderLineId: seeded.orderLineId },
    });
    expect(row.accountId).toBe(seeded.accountId);
    expect(row.artworkId).toBe(seeded.artworkId);
    expect(row.status).toBe('issued');
  });

  it('注文を `fulfilled` にする', async () => {
    const seeded = await seedPaidOrder(1);
    await repo.issueForOrder(seeded.orderId, NOW);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: seeded.orderId } });
    expect(order.fulfillmentStatus).toBe('fulfilled');
  });
});

suite('何度呼んでも増えない', () => {
  it('10 回呼んでも枚数が変わらない', async () => {
    const seeded = await seedPaidOrder(3);
    for (let i = 0; i < 10; i += 1) {
      const result = await repo.issueForOrder(seeded.orderId, NOW);
      // ⚠️ 2 回目以降を失敗にしない。同じ知らせが 2 度届いただけ。
      expect(result.ok).toBe(true);
    }
    expect(await prisma.entitlement.count({ where: { orderLineId: seeded.orderLineId } })).toBe(3);
  });

  it('10 回呼んでも在庫カウンタが動かない', async () => {
    const seeded = await seedPaidOrder(3);
    for (let i = 0; i < 10; i += 1) {
      await repo.issueForOrder(seeded.orderId, NOW);
    }
    // ⚠️ ここが動くと、10 回受け取るたびに枠が減っていく。
    expect(await counters(seeded.artworkId)).toMatchObject({ reservedCount: 0, issuedCount: 3 });
  });

  it('同時に 5 本走らせても 3 枚しかできない', async () => {
    /*
      ⚠️ **ここが要。** 作品行のロックが実際の防壁で、
         `UNIQUE(order_line_id, unit_index)` がそれを迂回した経路への最終防壁。
         どちらか片方でも欠けると、同時に届いた Webhook が二重に発行する。
    */
    const seeded = await seedPaidOrder(3);
    await Promise.all(
      Array.from({ length: 5 }, () => repo.issueForOrder(seeded.orderId, NOW).catch(() => null)),
    );
    expect(await prisma.entitlement.count({ where: { orderLineId: seeded.orderLineId } })).toBe(3);
    expect(await counters(seeded.artworkId)).toMatchObject({ reservedCount: 0, issuedCount: 3 });
  });
});

suite('途中で落ちても不足分だけ作る', () => {
  it('1 枚できている状態から、残り 2 枚だけ作る', async () => {
    const seeded = await seedPaidOrder(3);
    // 途中まで進んだ状態を手で作る。1 枚ぶんは発行済みへ移してある。
    await prisma.entitlement.create({
      data: {
        orderId: seeded.orderId,
        orderLineId: seeded.orderLineId,
        artworkId: seeded.artworkId,
        accountId: seeded.accountId,
        serialNo: 1,
        unitIndex: 0,
        claimTokenHash: `hash-${randomUUID()}`,
        status: 'issued',
      },
    });
    await prisma.artwork.update({
      where: { id: seeded.artworkId },
      data: { reservedCount: 2, issuedCount: 1 },
    });

    const result = await repo.issueForOrder(seeded.orderId, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // ⚠️ 3 枚ではなく 2 枚。作り直しではなく、埋め合わせ。
    expect(result.value.issued).toBe(2);

    const rows = await prisma.entitlement.findMany({
      where: { orderLineId: seeded.orderLineId },
      orderBy: { unitIndex: 'asc' },
    });
    expect(rows.map((row) => row.unitIndex)).toEqual([0, 1, 2]);
    // ⚠️ 番号は 1 番から採り直さない。既に 1 番が出ている。
    expect(rows.map((row) => row.serialNo)).toEqual([1, 2, 3]);
  });
});

suite('DB が最後に止める', () => {
  it('同じ明細の同じ枚数目を直に 2 度入れられない', async () => {
    const seeded = await seedPaidOrder(1);
    await repo.issueForOrder(seeded.orderId, NOW);

    const attempt = prisma.entitlement.create({
      data: {
        orderId: seeded.orderId,
        orderLineId: seeded.orderLineId,
        artworkId: seeded.artworkId,
        accountId: seeded.accountId,
        // シリアル番号は別のものを使う。止まる理由を 1 つに絞るため。
        serialNo: 99,
        unitIndex: 0,
        claimTokenHash: `hash-${randomUUID()}`,
        status: 'issued',
      },
    });
    await expect(attempt).rejects.toSatisfy(violatesUniqueConstraint);
  });

  it('上限そのものは、正しい発行では決して超えない', async () => {
    /*
      ⚠️ **押さえた枠を発行済みへ「移す」だけなので、合計は動かない。**
         だから `reserved + issued <= max` の CHECK は、正しい発行では
         決して発火しない。ここで確かめているのは、上限ちょうどまで
         売り切っても通ること——**上限で弾かれて最後の 1 枚が発行できない、
         という事故が起きないこと**である。
    */
    const seeded = await seedPaidOrder(3, { maxSupply: 3 });
    const result = await repo.issueForOrder(seeded.orderId, NOW);
    expect(result.ok).toBe(true);
    expect(await counters(seeded.artworkId)).toMatchObject({
      maxSupply: 3,
      reservedCount: 0,
      issuedCount: 3,
    });
  });

  it('押さえた枠より多く発行しようとすると、1 枚も作らずに止まる', async () => {
    /*
      ⚠️ **在庫の記録が壊れているときの振る舞い。** 決済が済んだ注文の枠は
         解放しない決まり（決定 A）なので通常は起こらないが、起きたときに
         「作れるだけ作る」と、あとから何が起きたのか誰にも分からなくなる。
    */
    const seeded = await seedPaidOrder(3);
    // 押さえを 1 枠だけに減らす。3 枚の注文に対して足りない。
    await prisma.artwork.update({ where: { id: seeded.artworkId }, data: { reservedCount: 1 } });

    const result = await repo.issueForOrder(seeded.orderId, NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('ENTITLEMENT_SUPPLY_MISMATCH');
    // ⚠️ 途中まで作って止まらない。
    expect(await prisma.entitlement.count({ where: { orderLineId: seeded.orderLineId } })).toBe(0);
    expect(await counters(seeded.artworkId)).toMatchObject({ reservedCount: 1, issuedCount: 0 });
  });
});

suite('決済が済んでいない注文', () => {
  it('受取権を作らない', async () => {
    const seeded = await seedPaidOrder(1, { paymentStatus: 'not_started' });
    const result = await repo.issueForOrder(seeded.orderId, NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('ENTITLEMENT_ORDER_NOT_PAID');
    expect(await prisma.entitlement.count({ where: { orderLineId: seeded.orderLineId } })).toBe(0);
  });

  it('掃き出しにも拾われない', async () => {
    await seedPaidOrder(1, { paymentStatus: 'not_started' });
    expect(await repo.listPending(10, NOW)).toEqual([]);
  });
});

suite('掃き出しの取り出し', () => {
  it('発行が要る注文を拾う', async () => {
    const seeded = await seedPaidOrder(1);
    const pending = await repo.listPending(10, NOW);
    expect(pending.map((row) => row.orderId)).toEqual([seeded.orderId]);
  });

  it('発行が済んだ注文は拾わない', async () => {
    const seeded = await seedPaidOrder(1);
    await repo.issueForOrder(seeded.orderId, NOW);
    expect(await repo.listPending(10, NOW)).toEqual([]);
  });

  it('待ち時間が来ていない注文は拾わない', async () => {
    const seeded = await seedPaidOrder(1);
    await repo.recordFailure({ orderId: seeded.orderId, code: 'boom', now: NOW });
    expect(await repo.listPending(10, NOW)).toEqual([]);
  });

  it('待ち時間が過ぎたら拾い直す', async () => {
    const seeded = await seedPaidOrder(1);
    await repo.recordFailure({ orderId: seeded.orderId, code: 'boom', now: NOW });
    const later = new Date(NOW.getTime() + 24 * 60 * 60_000);
    expect((await repo.listPending(10, later)).map((row) => row.orderId)).toEqual([seeded.orderId]);
  });

  it('上限まで試した注文は拾わない（人手に回っている）', async () => {
    const seeded = await seedPaidOrder(1);
    for (let attempt = 0; attempt < ISSUANCE_MAX_ATTEMPTS; attempt += 1) {
      await repo.recordFailure({ orderId: seeded.orderId, code: 'boom', now: NOW });
    }
    const later = new Date(NOW.getTime() + 365 * 24 * 60 * 60_000);
    expect(await repo.listPending(10, later)).toEqual([]);
  });
});

suite('失敗の記録', () => {
  it('試行回数を 1 つずつ進める', async () => {
    const seeded = await seedPaidOrder(1);
    const first = await repo.recordFailure({ orderId: seeded.orderId, code: 'boom', now: NOW });
    expect(first.attemptCount).toBe(1);
    const second = await repo.recordFailure({ orderId: seeded.orderId, code: 'boom', now: NOW });
    expect(second.attemptCount).toBe(2);
  });

  it('上限に達したら次の時刻を置かない', async () => {
    const seeded = await seedPaidOrder(1);
    let last = await repo.recordFailure({ orderId: seeded.orderId, code: 'boom', now: NOW });
    for (let attempt = 1; attempt < ISSUANCE_MAX_ATTEMPTS; attempt += 1) {
      last = await repo.recordFailure({ orderId: seeded.orderId, code: 'boom', now: NOW });
    }
    expect(last.exhausted).toBe(true);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: seeded.orderId } });
    expect(order.issuanceNextAttemptAt).toBeNull();
  });

  it('符号だけを残す（例外の本文を残さない）', async () => {
    const seeded = await seedPaidOrder(1);
    await repo.recordFailure({ orderId: seeded.orderId, code: 'unexpected_error', now: NOW });
    const order = await prisma.order.findUniqueOrThrow({ where: { id: seeded.orderId } });
    expect(order.issuanceLastError).toBe('unexpected_error');
  });

  it('発行が成ったら失敗の跡を消す', async () => {
    const seeded = await seedPaidOrder(1);
    await repo.recordFailure({ orderId: seeded.orderId, code: 'boom', now: NOW });
    await repo.issueForOrder(seeded.orderId, NOW);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: seeded.orderId } });
    expect(order.issuanceAttemptCount).toBe(0);
    expect(order.issuanceNextAttemptAt).toBeNull();
    expect(order.issuanceLastError).toBeNull();
  });
});

suite('件数の食い違いを見つける', () => {
  it('合っていれば何も返さない', async () => {
    const seeded = await seedPaidOrder(2);
    await repo.issueForOrder(seeded.orderId, NOW);
    expect(await repo.reconcile()).toEqual([]);
  });

  it('カウンタが多い作品を見つける（発行の取りこぼし）', async () => {
    const seeded = await seedPaidOrder(2);
    await repo.issueForOrder(seeded.orderId, NOW);
    await prisma.artwork.update({
      where: { id: seeded.artworkId },
      data: { issuedCount: 5, reservedCount: 0 },
    });

    const found = await repo.reconcile();
    expect(found).toHaveLength(1);
    // ⚠️ 符号で向きが分かる。直し方が逆になるため。
    expect(found[0]).toMatchObject({ artworkId: seeded.artworkId, drift: 3 });
  });

  it('受取権が多い作品を見つける（二重発行）', async () => {
    const seeded = await seedPaidOrder(2);
    await repo.issueForOrder(seeded.orderId, NOW);
    await prisma.artwork.update({
      where: { id: seeded.artworkId },
      data: { issuedCount: 1 },
    });
    const found = await repo.reconcile();
    expect(found[0]?.drift).toBe(-1);
  });

  it('直さない（数えて返すだけ）', async () => {
    const seeded = await seedPaidOrder(2);
    await repo.issueForOrder(seeded.orderId, NOW);
    await prisma.artwork.update({ where: { id: seeded.artworkId }, data: { issuedCount: 5 } });
    await repo.reconcile();
    // ⚠️ 機械が寄せると、事故の跡が消える。
    expect((await counters(seeded.artworkId)).issuedCount).toBe(5);
  });
});
