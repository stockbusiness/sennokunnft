import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../../generated/client';
import { PrismaRefundRepository } from '../../src/repositories/refund.repository';
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
 * 返金の記録（`UD-104` / `UD-120`）。
 *
 * ⚠️ ここはドメインの試験ではない。**アプリ側の判定に穴が開いたときに
 * 残る最後の砦**が本当に立っているかを見る。とくに:
 *   1. 同じ返金を 2 回積めないこと（部分 UNIQUE 索引）
 *   2. 事業者発の返金に運営の誰かが紐づかないこと（CHECK）
 *   3. `processing` の発行ジョブが `cancelled` にならないこと（`INV-M4`）
 *   4. 在庫が戻り、通し番号（`issued_count`）は戻らないこと
 */
const enabled = integrationTestsAvailable();
const suite = enabled ? describe : describe.skip;

const NOW = new Date('2026-08-20T00:00:00.000Z');

let prisma: PrismaClient;
let repo: PrismaRefundRepository;

beforeAll(async () => {
  if (!enabled) return;
  prisma = createTestClient();
  await prisma.$connect();
  repo = new PrismaRefundRepository(prisma);
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
  readonly reservationId: string;
}

/** 支払い済みの注文を 1 件、予約と決済つきで作る。 */
async function seedPaidOrder(): Promise<Seeded> {
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
      title: '返金の試験の作品',
      maxSupply: 10,
      // 決済が確定しても、枠は reservedCount 側で押さえたまま（決定 A）。
      reservedCount: 1,
      status: 'published',
    },
  });
  const listing = await prisma.listing.create({
    data: { artworkId: artwork.id, priceAmount: 3000, priceCurrency: 'JPY' },
  });
  const order = await prisma.order.create({
    data: {
      accountId,
      totalAmount: 3000,
      totalCurrency: 'JPY',
      idempotencyKey: randomUUID(),
      status: 'paid',
      paymentStatus: 'succeeded',
      paidAt: NOW,
      refundableUntil: new Date(NOW.getTime() + 14 * 86_400_000),
      ...orderSeedFields({ creatorAccountId, totalAmount: 3000 }),
    },
  });
  const line = await prisma.orderLine.create({
    data: {
      orderId: order.id,
      listingId: listing.id,
      artworkId: artwork.id,
      artworkTitleSnapshot: '返金の試験の作品',
      unitPriceAmount: 3000,
      unitPriceCurrency: 'JPY',
      quantity: 1,
      ...orderLineSeedFields({ creatorAccountId, unitPriceAmount: 3000, quantity: 1 }),
    },
  });
  const payment = await prisma.payment.create({
    data: {
      orderId: order.id,
      provider: 'fake',
      providerPaymentRef: `pi_${randomUUID()}`,
      status: 'succeeded',
      amount: 3000,
      currency: 'JPY',
      paidAt: NOW,
    },
  });
  const reservation = await prisma.inventoryReservation.create({
    data: {
      orderId: order.id,
      listingId: listing.id,
      artworkId: artwork.id,
      quantity: 1,
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
    reservationId: reservation.id,
  };
}

async function startRefund(seeded: Seeded, overrides: Record<string, unknown> = {}) {
  return repo.start({
    refundId: randomUUID(),
    orderId: seeded.orderId,
    paymentId: seeded.paymentId,
    amount: 3000,
    currency: 'JPY',
    reason: 'buyer_request',
    initiatedBy: 'admin',
    actorAccountId: seeded.accountId,
    providerRefundRef: null,
    note: null,
    now: NOW,
    ...overrides,
  });
}

suite('refunds の制約', () => {
  it('同じ事業者側の識別子で 2 行作れない', async () => {
    /*
      ⚠️ **こちらから投げた返金にも、あとから知らせが届く。** アプリの
         注意力ではなく制約で止める。
    */
    const seeded = await seedPaidOrder();
    await startRefund(seeded, { providerRefundRef: 're_1' });
    await expect(startRefund(seeded, { providerRefundRef: 're_1' })).rejects.toSatisfy(
      (error: unknown) => violatesUniqueConstraint(error),
    );
  });

  it('まだ投げていない行は、何行でも作れる（NULL は重複しない）', async () => {
    const seeded = await seedPaidOrder();
    await startRefund(seeded);
    await expect(startRefund(seeded)).resolves.toMatchObject({ status: 'requested' });
  });

  it('事業者発の返金に、運営の誰かを紐づけられない', async () => {
    // ⚠️ 紐づくと、こちらを経由した返金と見分けが付かなくなる。
    const seeded = await seedPaidOrder();
    await expect(
      startRefund(seeded, { initiatedBy: 'provider', actorAccountId: seeded.accountId }),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'refunds_provider_has_no_actor'),
    );
  });

  it('0 円の返金は作れない', async () => {
    const seeded = await seedPaidOrder();
    await expect(startRefund(seeded, { amount: 0 })).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'refunds_amount_positive'),
    );
  });

  it('知らない理由は作れない', async () => {
    const seeded = await seedPaidOrder();
    await expect(startRefund(seeded, { reason: 'because' })).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'refunds_reason_known'),
    );
  });

  it('成立した行には、成立の時刻が必ず入る', async () => {
    const seeded = await seedPaidOrder();
    const refund = await startRefund(seeded);
    await expect(
      prisma.refund.update({ where: { id: refund.id }, data: { status: 'succeeded' } }),
    ).rejects.toSatisfy((error: unknown) => violatesConstraint(error, 'refunds_settled_has_time'));
  });
});

suite('返金の反映', () => {
  it('注文・決済・在庫を 1 度に片づける', async () => {
    const seeded = await seedPaidOrder();
    const refund = await startRefund(seeded);

    const settlement = await repo.settle({
      refundId: refund.id,
      orderId: seeded.orderId,
      providerRefundRef: 're_settled',
      amountRefundedTotal: 3000,
      revokeEntitlement: true,
      cancelMintJob: false,
      mintNote: null,
      now: NOW,
    });

    expect(settlement.alreadySettled).toBe(false);
    expect(settlement.refundStatus).toBe('refunded');
    // ⚠️ 決済が確定しても押さえたままだった枠を、ここで戻す。
    expect(settlement.restoredSupply).toBe(1);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: seeded.orderId } });
    expect(order.refundStatus).toBe('refunded');

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: seeded.paymentId } });
    expect(payment.amountRefunded).toBe(3000);

    const artwork = await prisma.artwork.findUniqueOrThrow({ where: { id: seeded.artworkId } });
    expect(artwork.reservedCount).toBe(0);

    const reservation = await prisma.inventoryReservation.findUniqueOrThrow({
      where: { id: seeded.reservationId },
    });
    expect(reservation.status).toBe('released');
  });

  it('二度目は何もしない（二重に在庫を戻さない）', async () => {
    const seeded = await seedPaidOrder();
    const refund = await startRefund(seeded);
    const command = {
      refundId: refund.id,
      orderId: seeded.orderId,
      providerRefundRef: 're_settled',
      amountRefundedTotal: 3000,
      revokeEntitlement: true,
      cancelMintJob: false,
      mintNote: null,
      now: NOW,
    };

    await repo.settle(command);
    const second = await repo.settle(command);

    expect(second.alreadySettled).toBe(true);
    expect(second.restoredSupply).toBe(0);
    const artwork = await prisma.artwork.findUniqueOrThrow({ where: { id: seeded.artworkId } });
    // ⚠️ 0 のまま。マイナスにならない。
    expect(artwork.reservedCount).toBe(0);
  });

  it('一部返金では `partially_refunded` になる', async () => {
    const seeded = await seedPaidOrder();
    const refund = await startRefund(seeded, { amount: 1000 });

    const settlement = await repo.settle({
      refundId: refund.id,
      orderId: seeded.orderId,
      providerRefundRef: 're_part',
      amountRefundedTotal: 1000,
      revokeEntitlement: false,
      cancelMintJob: false,
      mintNote: null,
      now: NOW,
    });

    expect(settlement.refundStatus).toBe('partially_refunded');
  });

  it('`processing` の発行ジョブを取り消さず、注記だけ足す（`INV-M4`）', async () => {
    /*
      ⚠️ **外部へ送信済みの可能性がある。** 取り消すと多重発行になり、
         これは回復できない。ここが崩れると、返金のたびに二重発行が起きる。
    */
    const seeded = await seedPaidOrder();
    const entitlement = await prisma.entitlement.create({
      data: {
        orderId: seeded.orderId,
        orderLineId: seeded.orderLineId,
        artworkId: seeded.artworkId,
        accountId: seeded.accountId,
        serialNo: 1,
        // 1 明細 1 枚の下地なので 0 枚目。
        unitIndex: 0,
        claimTokenHash: `hash-${randomUUID()}`,
        status: 'claimed',
        // ⚠️ `claimed` には受け取った人と時刻が要る（既存の CHECK）。
        claimedByAccountId: seeded.accountId,
        claimedAt: NOW,
      },
    });
    const job = await prisma.mintJob.create({
      data: {
        entitlementId: entitlement.id,
        status: 'processing',
        idempotencyKey: `mint-${randomUUID()}`,
      },
    });
    const refund = await startRefund(seeded);

    const settlement = await repo.settle({
      refundId: refund.id,
      orderId: seeded.orderId,
      providerRefundRef: 're_processing',
      amountRefundedTotal: 3000,
      revokeEntitlement: false,
      cancelMintJob: true,
      mintNote: '外部へ送信済みの可能性があるため取り消していません。',
      now: NOW,
    });

    expect(settlement.cancelledMintJobs).toBe(0);
    expect(settlement.annotatedMintJobs).toBe(1);
    const after = await prisma.mintJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe('processing');
    expect(after.note).not.toBeNull();
  });

  it('`queued` の発行ジョブは取り消す', async () => {
    const seeded = await seedPaidOrder();
    const entitlement = await prisma.entitlement.create({
      data: {
        orderId: seeded.orderId,
        orderLineId: seeded.orderLineId,
        artworkId: seeded.artworkId,
        accountId: seeded.accountId,
        serialNo: 1,
        // 1 明細 1 枚の下地なので 0 枚目。
        unitIndex: 0,
        claimTokenHash: `hash-${randomUUID()}`,
        status: 'claimed',
        // ⚠️ `claimed` には受け取った人と時刻が要る（既存の CHECK）。
        claimedByAccountId: seeded.accountId,
        claimedAt: NOW,
      },
    });
    await prisma.mintJob.create({
      data: {
        entitlementId: entitlement.id,
        status: 'queued',
        idempotencyKey: `mint-${randomUUID()}`,
      },
    });
    const refund = await startRefund(seeded);

    const settlement = await repo.settle({
      refundId: refund.id,
      orderId: seeded.orderId,
      providerRefundRef: 're_queued',
      amountRefundedTotal: 3000,
      revokeEntitlement: false,
      cancelMintJob: true,
      mintNote: null,
      now: NOW,
    });

    expect(settlement.cancelledMintJobs).toBe(1);
  });

  it('通し番号（`issued_count`）は戻さない', async () => {
    /*
      ⚠️ **戻すと、次に発行した受取権が同じ番号になり、
         `(artwork_id, serial_no)` の UNIQUE で弾かれる。** 返金した番号は
         使い切りとして扱う——販売枠が 1 つ減るが、番号の重複よりよい。
    */
    const seeded = await seedPaidOrder();
    await prisma.artwork.update({ where: { id: seeded.artworkId }, data: { issuedCount: 1 } });
    const refund = await startRefund(seeded);

    await repo.settle({
      refundId: refund.id,
      orderId: seeded.orderId,
      providerRefundRef: 're_serial',
      amountRefundedTotal: 3000,
      revokeEntitlement: true,
      cancelMintJob: false,
      mintNote: null,
      now: NOW,
    });

    const artwork = await prisma.artwork.findUniqueOrThrow({ where: { id: seeded.artworkId } });
    expect(artwork.issuedCount).toBe(1);
  });
});

suite('返金の判定に要る値', () => {
  it('注文が無ければ null（「空の姿」を返さない）', async () => {
    await expect(repo.loadContext(randomUUID())).resolves.toBeNull();
  });

  it('決済の世代と識別子を返す（返金の宛先になる）', async () => {
    const seeded = await seedPaidOrder();
    const context = await repo.loadContext(seeded.orderId);
    expect(context).toMatchObject({ paymentId: seeded.paymentId, paymentStatus: 'succeeded' });
    expect(context?.paymentRef).not.toBeNull();
  });

  it('いちばん進んだ状態を返す（件数で丸めない）', async () => {
    // ⚠️ 1 件でも発行処理中なら、注文としては人の確認へ回す。
    const seeded = await seedPaidOrder();
    for (const [serialNo, status] of [
      [1, 'issued'],
      [2, 'claimed'],
    ] as const) {
      await prisma.entitlement.create({
        data: {
          orderId: seeded.orderId,
          orderLineId: seeded.orderLineId,
          artworkId: seeded.artworkId,
          accountId: seeded.accountId,
          serialNo,
          // ⚠️ 同じ明細に 2 枚作るので、枚数目もずらす。
          //    `UNIQUE(order_line_id, unit_index)` が同じ番号を許さない。
          unitIndex: serialNo - 1,
          claimTokenHash: `hash-${randomUUID()}`,
          status,
          // ⚠️ `claimed` には受け取った人と時刻が要る（既存の CHECK）。
          ...(status === 'claimed' ? { claimedByAccountId: seeded.accountId, claimedAt: NOW } : {}),
        },
      });
    }

    const context = await repo.loadContext(seeded.orderId);
    expect(context?.entitlementStatus).toBe('claimed');
  });

  it('失敗した決済は返金の宛先にしない', async () => {
    const seeded = await seedPaidOrder();
    await prisma.payment.update({
      where: { id: seeded.paymentId },
      data: { status: 'failed', paidAt: null },
    });
    const context = await repo.loadContext(seeded.orderId);
    expect(context?.paymentId).toBeNull();
  });
});
