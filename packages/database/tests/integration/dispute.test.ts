import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../../generated/client';
import { PrismaDisputeRepository } from '../../src/repositories/dispute.repository';
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
 * チャージバック（決済の争い）の記録。
 *
 * ⚠️ ここはドメインの試験ではない。**アプリ側の判定に穴が開いたときに
 * 残る最後の砦**が本当に立っているかを見る。とくに:
 *   1. 同じ争いが 2 行にならないこと（`(provider, dispute_ref)` の UNIQUE）
 *   2. 決着した争いに時刻が必ず入ること（CHECK）
 *   3. 勝った争いに返金が紐づかないこと（CHECK）
 *   4. 知らない状態・理由が入らないこと（CHECK）
 */
const enabled = integrationTestsAvailable();
const suite = enabled ? describe : describe.skip;

const NOW = new Date('2026-08-22T00:00:00.000Z');
const LATER = new Date('2026-08-25T00:00:00.000Z');

let prisma: PrismaClient;
let repo: PrismaDisputeRepository;

beforeAll(async () => {
  if (!enabled) return;
  prisma = createTestClient();
  await prisma.$connect();
  repo = new PrismaDisputeRepository(prisma);
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
  readonly paymentId: string;
  readonly creatorAccountId: string;
}

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
      title: '争いの試験の作品',
      maxSupply: 10,
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
  await prisma.orderLine.create({
    data: {
      orderId: order.id,
      listingId: listing.id,
      artworkId: artwork.id,
      artworkTitleSnapshot: '争いの試験の作品',
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
  return { orderId: order.id, paymentId: payment.id, creatorAccountId };
}

function command(seeded: Seeded, overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    orderId: seeded.orderId,
    paymentId: seeded.paymentId,
    provider: 'fake',
    disputeRef: 'dp_1',
    status: 'needs_response' as const,
    reason: 'fraudulent' as const,
    amount: 3000,
    currency: 'JPY',
    occurredAt: NOW,
    now: NOW,
    ...overrides,
  };
}

suite('争いを受ける', () => {
  it('初めての知らせで 1 行できる', async () => {
    const seeded = await seedPaidOrder();
    const outcome = await repo.record(command(seeded));

    expect(outcome.advanced).toBe(true);
    expect(outcome.record.status).toBe('needs_response');
    // ⚠️ 決着していないので、終わった時刻は入らない。
    expect(outcome.record.closedAt).toBeNull();
    expect(outcome.record.refundId).toBeNull();
  });

  it('同じ争いの知らせが 2 回来ても 1 行のまま', async () => {
    /*
      ⚠️ **申し立て・審理・決着で別々の知らせが届く。** 識別子で束ねないと、
         1 件の争いが 3 件に増え、精算が 3 重に止まる。
    */
    const seeded = await seedPaidOrder();
    await repo.record(command(seeded));
    const second = await repo.record(command(seeded));

    expect(second.advanced).toBe(false);
    await expect(prisma.paymentDispute.count()).resolves.toBe(1);
  });

  it('状態が進むと更新される', async () => {
    const seeded = await seedPaidOrder();
    const first = await repo.record(command(seeded));
    const second = await repo.record(
      command(seeded, { status: 'under_review', occurredAt: LATER, now: LATER }),
    );

    expect(second.advanced).toBe(true);
    expect(second.record.id).toBe(first.record.id);
    expect(second.record.status).toBe('under_review');
  });

  it('敗訴で決着すると、終わった時刻が入る', async () => {
    const seeded = await seedPaidOrder();
    await repo.record(command(seeded));
    const closed = await repo.record(
      command(seeded, { status: 'lost', occurredAt: LATER, now: LATER }),
    );

    expect(closed.record.status).toBe('lost');
    expect(closed.record.closedAt).toEqual(LATER);
  });

  it('決着したあとに古い知らせが届いても、開き直さない', async () => {
    /*
      ⚠️ **事業者の知らせは前後して届く。** 素直に上書きすると、決着した
         争いが開き直り、**精算が理由なく止まり続ける**。
    */
    const seeded = await seedPaidOrder();
    await repo.record(command(seeded, { status: 'lost', occurredAt: LATER, now: LATER }));
    const late = await repo.record(command(seeded, { status: 'needs_response' }));

    expect(late.advanced).toBe(false);
    expect(late.record.status).toBe('lost');
    expect(late.record.closedAt).toEqual(LATER);
  });

  it('勝ったあとに負けへ書き換えられない', async () => {
    const seeded = await seedPaidOrder();
    await repo.record(command(seeded, { status: 'won', occurredAt: LATER, now: LATER }));
    const flipped = await repo.record(
      command(seeded, { status: 'lost', occurredAt: LATER, now: LATER }),
    );

    expect(flipped.advanced).toBe(false);
    expect(flipped.record.status).toBe('won');
  });

  it('別の争いなら別の行になる', async () => {
    const seeded = await seedPaidOrder();
    await repo.record(command(seeded, { disputeRef: 'dp_1' }));
    await repo.record(command(seeded, { disputeRef: 'dp_2' }));

    await expect(prisma.paymentDispute.count()).resolves.toBe(2);
    await expect(repo.listByOrder(seeded.orderId)).resolves.toHaveLength(2);
  });
});

suite('DB が止めること', () => {
  it('同じ事業者・同じ識別子で 2 行作れない', async () => {
    const seeded = await seedPaidOrder();
    await repo.record(command(seeded));

    await expect(
      prisma.paymentDispute.create({
        data: {
          id: randomUUID(),
          orderId: seeded.orderId,
          provider: 'fake',
          disputeRef: 'dp_1',
          status: 'needs_response',
          reason: 'fraudulent',
          amount: 3000,
          currency: 'JPY',
          openedAt: NOW,
        },
      }),
    ).rejects.toSatisfy(violatesUniqueConstraint);
  });

  it('知らない状態は入らない', async () => {
    const seeded = await seedPaidOrder();
    await expect(
      prisma.paymentDispute.create({
        data: {
          id: randomUUID(),
          orderId: seeded.orderId,
          provider: 'fake',
          disputeRef: 'dp_x',
          status: 'maybe_lost',
          reason: 'fraudulent',
          amount: 3000,
          currency: 'JPY',
          openedAt: NOW,
        },
      }),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'payment_disputes_status_known'),
    );
  });

  it('知らない理由は入らない', async () => {
    const seeded = await seedPaidOrder();
    await expect(
      prisma.paymentDispute.create({
        data: {
          id: randomUUID(),
          orderId: seeded.orderId,
          provider: 'fake',
          disputeRef: 'dp_y',
          status: 'needs_response',
          reason: 'card_was_stolen_probably',
          amount: 3000,
          currency: 'JPY',
          openedAt: NOW,
        },
      }),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'payment_disputes_reason_known'),
    );
  });

  it('決着したのに終わった時刻が無い行を作れない', async () => {
    /*
      ⚠️ **「いつ終わったのか」が読めないと、証拠の保管期間を数える起点が
         消える。**
    */
    const seeded = await seedPaidOrder();
    await expect(
      prisma.paymentDispute.create({
        data: {
          id: randomUUID(),
          orderId: seeded.orderId,
          provider: 'fake',
          disputeRef: 'dp_z',
          status: 'lost',
          reason: 'fraudulent',
          amount: 3000,
          currency: 'JPY',
          openedAt: NOW,
          closedAt: null,
        },
      }),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'payment_disputes_closed_has_time'),
    );
  });

  it('決着していないのに終わった時刻がある行を作れない', async () => {
    const seeded = await seedPaidOrder();
    await expect(
      prisma.paymentDispute.create({
        data: {
          id: randomUUID(),
          orderId: seeded.orderId,
          provider: 'fake',
          disputeRef: 'dp_w',
          status: 'under_review',
          reason: 'fraudulent',
          amount: 3000,
          currency: 'JPY',
          openedAt: NOW,
          closedAt: LATER,
        },
      }),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'payment_disputes_closed_has_time'),
    );
  });

  it('0 円の争いは作れない', async () => {
    const seeded = await seedPaidOrder();
    await expect(
      prisma.paymentDispute.create({
        data: {
          id: randomUUID(),
          orderId: seeded.orderId,
          provider: 'fake',
          disputeRef: 'dp_0',
          status: 'needs_response',
          reason: 'fraudulent',
          amount: 0,
          currency: 'JPY',
          openedAt: NOW,
        },
      }),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'payment_disputes_amount_positive'),
    );
  });
});

suite('返金との紐づけ', () => {
  async function lostDispute(seeded: Seeded) {
    await repo.record(command(seeded));
    const closed = await repo.record(
      command(seeded, { status: 'lost', occurredAt: LATER, now: LATER }),
    );
    return closed.record;
  }

  async function makeRefund(seeded: Seeded) {
    return prisma.refund.create({
      data: {
        orderId: seeded.orderId,
        paymentId: seeded.paymentId,
        amount: 3000,
        currency: 'JPY',
        reason: 'provider_initiated',
        initiatedBy: 'provider',
        status: 'succeeded',
        settledAt: LATER,
        // ⚠️ チャージバックは運営が被る。作家さまへ回さない。
        clawbackBearer: 'platform',
      },
    });
  }

  it('敗訴した争いに返金を結べる', async () => {
    const seeded = await seedPaidOrder();
    const dispute = await lostDispute(seeded);
    const refund = await makeRefund(seeded);

    await expect(
      repo.attachRefund({ disputeId: dispute.id, refundId: refund.id, now: LATER }),
    ).resolves.toBe(true);

    const after = await repo.findByRef('fake', 'dp_1');
    expect(after?.refundId).toBe(refund.id);
  });

  it('二度目は結ばない（上書きしない）', async () => {
    /*
      ⚠️ **上書きすると、同じ争いに 2 つの返金がぶら下がる。** どちらが
         本当の返金なのか、あとから読めなくなる。
    */
    const seeded = await seedPaidOrder();
    const dispute = await lostDispute(seeded);
    const first = await makeRefund(seeded);
    const second = await makeRefund(seeded);

    await repo.attachRefund({ disputeId: dispute.id, refundId: first.id, now: LATER });
    await expect(
      repo.attachRefund({ disputeId: dispute.id, refundId: second.id, now: LATER }),
    ).resolves.toBe(false);

    const after = await repo.findByRef('fake', 'dp_1');
    expect(after?.refundId).toBe(first.id);
  });

  it('決着していない争いには結べない', async () => {
    const seeded = await seedPaidOrder();
    const outcome = await repo.record(command(seeded));
    const refund = await makeRefund(seeded);

    await expect(
      repo.attachRefund({ disputeId: outcome.record.id, refundId: refund.id, now: LATER }),
    ).resolves.toBe(false);
  });

  it('勝った争いに返金が付いた行を、DB が拒む', async () => {
    /*
      ⚠️ **勝ったのに返金が付いていたら、どこかで取り違えている。**
         アプリの判定に穴が開いたときの最後の砦。
    */
    const seeded = await seedPaidOrder();
    const refund = await makeRefund(seeded);
    await expect(
      prisma.paymentDispute.create({
        data: {
          id: randomUUID(),
          orderId: seeded.orderId,
          provider: 'fake',
          disputeRef: 'dp_won',
          status: 'won',
          reason: 'fraudulent',
          amount: 3000,
          currency: 'JPY',
          openedAt: NOW,
          closedAt: LATER,
          refundId: refund.id,
        },
      }),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'payment_disputes_refund_only_when_lost'),
    );
  });
});
