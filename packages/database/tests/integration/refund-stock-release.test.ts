import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ClaimTokenPort } from '@sengoku/domain';
import type { PrismaClient } from '../../generated/client';
import { PrismaEntitlementIssuanceRepository } from '../../src/repositories/issuance.repository';
import { PrismaRefundRepository } from '../../src/repositories/refund.repository';
import {
  createTestClient,
  integrationTestsAvailable,
  orderLineSeedFields,
  orderSeedFields,
  resetDatabase,
} from '../helpers/database';

/**
 * 返金したときに在庫の押さえ（`reserved_count`）をいくつ戻すか。
 *
 * ⚠️ **決定 A のせいで、素直に「予約の数量ぶん戻す」は誤りになる。**
 * 決済が済んでも枠は `reserved_count` 側に残り、**受取権を発行した時点で**
 * その枠は `reserved_count` から `issued_count` へ移る。移したあとに
 * 予約の数量ぶんを戻すと、**同じ枠を二度戻す**ことになる。
 */
const enabled = integrationTestsAvailable();
const suite = enabled ? describe : describe.skip;

const NOW = new Date('2026-08-20T00:00:00.000Z');

/** 受取のための合言葉。⚠️ 中身はこの試験の関心ではない。 */
const tokens: ClaimTokenPort = {
  issue: () => {
    const token = randomUUID();
    return { token, tokenHash: `hash-${token}` };
  },
  hash: (token) => `hash-${token}`,
  matches: (token, expected) => `hash-${token}` === expected,
};

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
  readonly orderId: string;
  readonly orderLineId: string;
  readonly paymentId: string;
  readonly artworkId: string;
  readonly accountId: string;
}

/**
 * 支払いが済み、仮引当が `consumed` になった注文を 1 件。
 *
 * ⚠️ `reservedCount` は数量ぶん立てたまま（決定 A）。受取権はまだ無い。
 */
async function seedPaidOrder(quantity: number): Promise<Seeded> {
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
      title: '在庫戻しの試験の作品',
      maxSupply: 10,
      reservedCount: quantity,
      issuedCount: 0,
      status: 'published',
    },
  });
  const listing = await prisma.listing.create({
    data: { artworkId: artwork.id, priceAmount: 3000, priceCurrency: 'JPY' },
  });
  const total = 3000 * quantity;
  const order = await prisma.order.create({
    data: {
      accountId,
      totalAmount: total,
      totalCurrency: 'JPY',
      idempotencyKey: randomUUID(),
      status: 'paid',
      paymentStatus: 'succeeded',
      paidAt: NOW,
      refundableUntil: new Date(NOW.getTime() + 14 * 86_400_000),
      ...orderSeedFields({ creatorAccountId, totalAmount: total }),
    },
  });
  const line = await prisma.orderLine.create({
    data: {
      orderId: order.id,
      listingId: listing.id,
      artworkId: artwork.id,
      artworkTitleSnapshot: '在庫戻しの試験の作品',
      unitPriceAmount: 3000,
      unitPriceCurrency: 'JPY',
      quantity,
      ...orderLineSeedFields({ creatorAccountId, unitPriceAmount: 3000, quantity }),
    },
  });
  const payment = await prisma.payment.create({
    data: {
      orderId: order.id,
      provider: 'fake',
      providerPaymentRef: `pi_${randomUUID()}`,
      status: 'succeeded',
      amount: total,
      currency: 'JPY',
      paidAt: NOW,
    },
  });
  await prisma.inventoryReservation.create({
    data: {
      orderId: order.id,
      listingId: listing.id,
      artworkId: artwork.id,
      quantity,
      status: 'consumed',
      expiresAt: new Date(NOW.getTime() + 3_600_000),
      consumedAt: NOW,
    },
  });
  return {
    orderId: order.id,
    orderLineId: line.id,
    paymentId: payment.id,
    artworkId: artwork.id,
    accountId,
  };
}

async function refundInFull(seeded: Seeded, amount: number): Promise<number> {
  const repo = new PrismaRefundRepository(prisma);
  const started = await repo.start({
    refundId: randomUUID(),
    orderId: seeded.orderId,
    paymentId: seeded.paymentId,
    amount,
    currency: 'JPY',
    reason: 'buyer_request',
    initiatedBy: 'admin',
    actorAccountId: seeded.accountId,
    providerRefundRef: null,
    note: null,
    now: NOW,
  });
  const settled = await repo.settle({
    refundId: started.id,
    orderId: seeded.orderId,
    amountRefundedTotal: amount,
    providerRefundRef: `re_${randomUUID()}`,
    outboxEventId: randomUUID(),
    // ⚠️ 実際の全額返金と同じにする。受取権は `revoked` へ進むが**残る**。
    revokeEntitlement: true,
    revokeClaimedEntitlements: false,
    planRevocation: null,
    cancelMintJob: true,
    mintNote: null,
    now: NOW,
  });
  return settled.restoredSupply;
}

async function counters(artworkId: string) {
  return prisma.artwork.findUniqueOrThrow({
    where: { id: artworkId },
    select: { maxSupply: true, reservedCount: true, issuedCount: true },
  });
}

suite('返金したときの在庫の戻し', () => {
  it('一部だけ発行済みなら、残りの枠だけを戻す', async () => {
    /*
      ⚠️ **引き算そのものを押さえる試験。** 戻す枠が 0 の場合は手前で
         `continue` するため、引く数を間違えていても素通りする。
         「一部だけ」の形にして、引く数が数量ではなく**残り**であることを
         確かめる。
      発行が途中で落ちた注文（2 個のうち 1 個だけできた）を組み立てる。
    */
    const seeded = await seedPaidOrder(2);
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
    // 1 個ぶんは発行時に issued 側へ移っている。押さえは残り 1。
    await prisma.artwork.update({
      where: { id: seeded.artworkId },
      data: { reservedCount: 1, issuedCount: 1 },
    });

    const restored = await refundInFull(seeded, 6000);

    expect(restored).toBe(1);
    expect(await counters(seeded.artworkId)).toMatchObject({
      reservedCount: 0,
      issuedCount: 1,
    });
  });

  it('ほかの方のお取り置きが残っていても、その枠を横取りしない', async () => {
    /*
      ⚠️ **こちらのほうが恐い。** `reserved_count` が 0 まで下がらない
         ときは CHECK に引っかからず、**黙って通る**。減りすぎた押さえは
         そのまま「まだ売れる枠」に見えるので、売り越しになる。
    */
    const seeded = await seedPaidOrder(1);
    const issued = await new PrismaEntitlementIssuanceRepository(prisma, tokens).issueForOrder(
      seeded.orderId,
      NOW,
    );
    expect(issued.ok).toBe(true);
    // 別の方が 3 枠を押さえている状態にする。
    await prisma.artwork.update({
      where: { id: seeded.artworkId },
      data: { reservedCount: 3 },
    });

    await refundInFull(seeded, 3000);

    // 他人の押さえは 3 のまま。返金した注文の枠はもう `issued` 側にある。
    expect(await counters(seeded.artworkId)).toMatchObject({
      reservedCount: 3,
      issuedCount: 1,
    });
  });

  it('受取権をまだ発行していなければ、押さえていた枠をそのまま戻す', async () => {
    const seeded = await seedPaidOrder(1);

    const restored = await refundInFull(seeded, 3000);

    expect(restored).toBe(1);
    // 発行していないので通し番号も進んでいない。枠はまるごと戻る。
    expect(await counters(seeded.artworkId)).toMatchObject({
      reservedCount: 0,
      issuedCount: 0,
    });
  });

  it('受取権を発行済みなら、押さえは発行時に移っているので戻す枠は無い', async () => {
    /*
      ⚠️ **ここが本題。** 発行の時点で `reserved_count` は `issued_count`
         へ移っている。返金でもう一度「予約の数量ぶん」を引くと、
         同じ枠を二度戻したことになり、**在庫が水増しされる**。
    */
    const seeded = await seedPaidOrder(1);
    const issued = await new PrismaEntitlementIssuanceRepository(prisma, tokens).issueForOrder(
      seeded.orderId,
      NOW,
    );
    expect(issued.ok).toBe(true);
    // 発行で枠が移ったことを、まず確かめる。
    expect(await counters(seeded.artworkId)).toMatchObject({
      reservedCount: 0,
      issuedCount: 1,
    });

    const restored = await refundInFull(seeded, 3000);

    // 戻す枠はもう無い。
    expect(restored).toBe(0);
    /*
      ⚠️ **`issued_count` は減らさない。** 通し番号は使い切り
         （`refund.repository.ts` の 6 番）。返金した 1 枠は失われる。
    */
    expect(await counters(seeded.artworkId)).toMatchObject({
      reservedCount: 0,
      issuedCount: 1,
    });
  });
});
