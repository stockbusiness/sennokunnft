import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../../generated/client';
import { PrismaPayoutRepository } from '../../src/repositories/payout.repository';
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
 * 作家さまへの精算（`UD-119`）。
 *
 * ⚠️ ここはドメインの試験ではない。**アプリ側の判定に穴が開いたときに
 * 残る最後の砦**が本当に立っているかを見る。とくに:
 *   1. **同じ注文が 2 回精算に入らないこと**（部分 UNIQUE 索引）
 *   2. 1 作家さま × 1 締め期間 = 1 行
 *   3. お支払額がマイナスにならないこと
 *   4. 締めたあとの精算を作り直せないこと
 */
const enabled = integrationTestsAvailable();
const suite = enabled ? describe : describe.skip;

const NOW = new Date('2026-09-20T00:00:00.000Z');
/** JST 8/1 0 時 = UTC 7/31 15 時。 */
const PERIOD_START = new Date('2026-07-31T15:00:00.000Z');
const PERIOD_END = new Date('2026-08-31T15:00:00.000Z');
const DUE_AT = new Date('2026-09-30T14:59:59.999Z');

let prisma: PrismaClient;
let repo: PrismaPayoutRepository;

beforeAll(async () => {
  if (!enabled) return;
  prisma = createTestClient();
  await prisma.$connect();
  repo = new PrismaPayoutRepository(prisma);
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
  readonly creatorAccountId: string;
  readonly buyerAccountId: string;
  readonly artworkId: string;
  readonly listingId: string;
}

async function seedCreator(): Promise<Seeded> {
  const creatorAccountId = randomUUID();
  const buyerAccountId = randomUUID();
  await prisma.account.createMany({
    data: [
      { id: creatorAccountId, authProvider: 'fake', authSubject: creatorAccountId },
      { id: buyerAccountId, authProvider: 'fake', authSubject: buyerAccountId },
    ],
  });
  const artwork = await prisma.artwork.create({
    data: {
      creatorAccountId,
      slug: `artwork-${randomUUID()}`,
      title: '精算の試験の作品',
      maxSupply: 100,
      status: 'published',
    },
  });
  const listing = await prisma.listing.create({
    data: { artworkId: artwork.id, priceAmount: 12000, priceCurrency: 'JPY' },
  });
  return { creatorAccountId, buyerAccountId, artworkId: artwork.id, listingId: listing.id };
}

/** 支払い済みの注文を 1 件。⚠️ 返金の窓は既定で閉じている。 */
async function seedPaidOrder(
  seeded: Seeded,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const order = await prisma.order.create({
    data: {
      accountId: seeded.buyerAccountId,
      totalAmount: 12000,
      totalCurrency: 'JPY',
      idempotencyKey: randomUUID(),
      status: 'paid',
      paymentStatus: 'succeeded',
      paidAt: new Date('2026-08-10T00:00:00.000Z'),
      refundableUntil: new Date('2026-08-24T00:00:00.000Z'),
      ...orderSeedFields({ creatorAccountId: seeded.creatorAccountId, totalAmount: 12000 }),
      // ⚠️ 手数料 20%。注文時点で確定している値をそのまま使う。
      platformFeeRateBps: 2000,
      platformFeeAmount: 2400,
      creatorAmount: 9600,
      ...overrides,
    },
  });
  await prisma.orderLine.create({
    data: {
      orderId: order.id,
      listingId: seeded.listingId,
      artworkId: seeded.artworkId,
      artworkTitleSnapshot: '精算の試験の作品',
      unitPriceAmount: 12000,
      unitPriceCurrency: 'JPY',
      quantity: 1,
      ...orderLineSeedFields({
        creatorAccountId: seeded.creatorAccountId,
        unitPriceAmount: 12000,
        quantity: 1,
      }),
    },
  });
  return order.id;
}

/**
 * 争いを 1 件（決定 B・2026-08-22）。
 *
 * ⚠️ **決着した状態には `closedAt` が要る。** DB の CHECK が
 * 「`won`/`lost` なら決着の時刻がある」を縛っている。
 */
async function seedDispute(orderId: string, status: string): Promise<void> {
  const closed = status === 'won' || status === 'lost';
  await prisma.paymentDispute.create({
    data: {
      orderId,
      provider: 'stripe',
      disputeRef: `dp_${randomUUID()}`,
      status,
      reason: 'fraudulent',
      amount: 12000,
      currency: 'JPY',
      openedAt: new Date('2026-08-15T00:00:00.000Z'),
      closedAt: closed ? new Date('2026-08-20T00:00:00.000Z') : null,
    },
  });
}

function draftCommand(seeded: Seeded, orderIds: readonly string[], overrides = {}) {
  return {
    payoutId: randomUUID(),
    creatorAccountId: seeded.creatorAccountId,
    periodKey: '2026-08',
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    dueAt: DUE_AT,
    currency: 'JPY',
    grossAmount: 12000 * orderIds.length,
    feeAmount: 2400 * orderIds.length,
    refundedAmount: 0,
    carriedInAmount: 0,
    netAmount: 9600 * orderIds.length,
    carriedOutAmount: 0,
    deferredDisputeCount: 0,
    deferredDisputeAmount: 0,
    minimumPayoutAmount: 1000,
    transferFeeBearer: 'creator' as const,
    lines: orderIds.map((orderId) => ({
      id: randomUUID(),
      orderId,
      orderNumber: 'SNK-0001',
      artworkTitleSnapshot: '精算の試験の作品',
      grossAmount: 12000,
      feeRateBps: 2000,
      feeAmount: 2400,
      netAmount: 9600,
      isClawback: false,
    })),
    now: NOW,
    ...overrides,
  };
}

suite('payouts の制約', () => {
  it('1 作家さま × 1 締め期間 = 1 行', async () => {
    // ⚠️ 2 つできると、どちらが正なのか誰にも分からなくなる。
    const seeded = await seedCreator();
    const orderId = await seedPaidOrder(seeded);
    await repo.saveDraft(draftCommand(seeded, [orderId]));

    await expect(
      prisma.payout.create({
        data: {
          creatorAccountId: seeded.creatorAccountId,
          periodKey: '2026-08',
          periodStart: PERIOD_START,
          periodEnd: PERIOD_END,
          dueAt: DUE_AT,
          minimumPayoutAmount: 1000,
          transferFeeBearer: 'creator',
        },
      }),
    ).rejects.toSatisfy((error: unknown) => violatesUniqueConstraint(error));
  });

  it('お支払額はマイナスにできない', async () => {
    /*
      ⚠️ **マイナスを許すと「作家さまへ請求する」形の行ができる。**
         差し引ききれない分は繰越（`carried_out_amount`）で表す。
    */
    const seeded = await seedCreator();
    await expect(
      prisma.payout.create({
        data: {
          creatorAccountId: seeded.creatorAccountId,
          periodKey: '2026-08',
          periodStart: PERIOD_START,
          periodEnd: PERIOD_END,
          dueAt: DUE_AT,
          netAmount: -1,
          minimumPayoutAmount: 1000,
          transferFeeBearer: 'creator',
        },
      }),
    ).rejects.toSatisfy((error: unknown) => violatesConstraint(error, 'payouts_net_not_negative'));
  });

  it('繰越はマイナスにできる（差し引ききれない分）', async () => {
    const seeded = await seedCreator();
    await expect(
      prisma.payout.create({
        data: {
          creatorAccountId: seeded.creatorAccountId,
          periodKey: '2026-08',
          periodStart: PERIOD_START,
          periodEnd: PERIOD_END,
          dueAt: DUE_AT,
          carriedOutAmount: -8600,
          minimumPayoutAmount: 1000,
          transferFeeBearer: 'creator',
        },
      }),
    ).resolves.toMatchObject({ carriedOutAmount: -8600 });
  });

  it('確定した精算には、確定の時刻が必ず入る', async () => {
    const seeded = await seedCreator();
    const orderId = await seedPaidOrder(seeded);
    const payout = await repo.saveDraft(draftCommand(seeded, [orderId]));

    await expect(
      prisma.payout.update({ where: { id: payout.id }, data: { status: 'confirmed' } }),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'payouts_confirmed_has_time'),
    );
  });

  it('支払い済みには、支払った時刻が必ず入る', async () => {
    const seeded = await seedCreator();
    const orderId = await seedPaidOrder(seeded);
    const payout = await repo.saveDraft(draftCommand(seeded, [orderId]));

    await expect(
      prisma.payout.update({
        where: { id: payout.id },
        data: { status: 'paid', confirmedAt: NOW },
      }),
    ).rejects.toSatisfy((error: unknown) => violatesConstraint(error, 'payouts_paid_has_time'));
  });

  it('知らない状態は作れない', async () => {
    const seeded = await seedCreator();
    await expect(
      prisma.payout.create({
        data: {
          creatorAccountId: seeded.creatorAccountId,
          periodKey: '2026-08',
          periodStart: PERIOD_START,
          periodEnd: PERIOD_END,
          dueAt: DUE_AT,
          status: 'cancelled',
          // ⚠️ ほかの CHECK を先に満たしておく。そうしないと、どの制約が
          //    止めたのか分からないまま緑になる。
          confirmedAt: NOW,
          minimumPayoutAmount: 1000,
          transferFeeBearer: 'creator',
        },
      }),
    ).rejects.toSatisfy((error: unknown) => violatesConstraint(error, 'payouts_status_known'));
  });
});

suite('二重払いを止める', () => {
  it('同じ注文を 2 つの精算に載せられない', async () => {
    /*
      ⚠️ **これが §3-3 の要。** 「同じ注文が 2 回精算に入る」を、アプリの
         注意力ではなく制約で止める。通すと、作家さまへ二重に支払われる。
    */
    const seeded = await seedCreator();
    const orderId = await seedPaidOrder(seeded);
    await repo.saveDraft(draftCommand(seeded, [orderId]));

    await expect(
      repo.saveDraft(draftCommand(seeded, [orderId], { periodKey: '2026-09' })),
    ).rejects.toSatisfy((error: unknown) => violatesUniqueConstraint(error));
  });

  it('同じ注文の差し戻しも 1 回まで', async () => {
    // ⚠️ 二度引くと、作家さまから取りすぎる。
    const seeded = await seedCreator();
    const orderId = await seedPaidOrder(seeded);
    const payout = await repo.saveDraft(draftCommand(seeded, []));

    const clawback = {
      payoutId: payout.id,
      orderId,
      orderNumber: 'SNK-0001',
      artworkTitleSnapshot: '精算の試験の作品',
      grossAmount: 0,
      feeRateBps: 0,
      feeAmount: 0,
      netAmount: -9600,
      isClawback: true,
    };
    await prisma.payoutLine.create({ data: { id: randomUUID(), ...clawback } });
    await expect(
      prisma.payoutLine.create({ data: { id: randomUUID(), ...clawback } }),
    ).rejects.toSatisfy((error: unknown) => violatesUniqueConstraint(error));
  });

  it('売上の行と差し戻しの行は、同じ注文で共存できる', async () => {
    // ⚠️ 「先月払った」「今月引いた」を両方残せないと、経緯が読めない。
    const seeded = await seedCreator();
    const orderId = await seedPaidOrder(seeded);
    const payout = await repo.saveDraft(draftCommand(seeded, [orderId]));

    await expect(
      prisma.payoutLine.create({
        data: {
          id: randomUUID(),
          payoutId: payout.id,
          orderId,
          orderNumber: 'SNK-0001',
          artworkTitleSnapshot: '精算の試験の作品',
          grossAmount: 0,
          feeRateBps: 0,
          feeAmount: 0,
          netAmount: -9600,
          isClawback: true,
        },
      }),
    ).resolves.toMatchObject({ isClawback: true });
  });

  it('差し戻しの行に販売額を入れられない', async () => {
    // ⚠️ 入れると、販売額の合計が二重に積まれる。
    const seeded = await seedCreator();
    const orderId = await seedPaidOrder(seeded);
    const payout = await repo.saveDraft(draftCommand(seeded, []));

    await expect(
      prisma.payoutLine.create({
        data: {
          id: randomUUID(),
          payoutId: payout.id,
          orderId,
          orderNumber: 'SNK-0001',
          artworkTitleSnapshot: '精算の試験の作品',
          grossAmount: 12000,
          feeRateBps: 2000,
          feeAmount: 2400,
          netAmount: -9600,
          isClawback: true,
        },
      }),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'payout_lines_clawback_shape'),
    );
  });
});

suite('下書きの作り直し', () => {
  it('下書きなら置き換えられる（明細ごと）', async () => {
    const seeded = await seedCreator();
    const first = await seedPaidOrder(seeded);
    const payout = await repo.saveDraft(draftCommand(seeded, [first]));

    const second = await seedPaidOrder(seeded);
    const rebuilt = await repo.saveDraft(draftCommand(seeded, [first, second]));

    expect(rebuilt.id).not.toBe(payout.id);
    expect(rebuilt.lineCount).toBe(2);
    // ⚠️ 古い行が残っていないこと。残ると二重払いの UNIQUE で次が作れない。
    await expect(prisma.payoutLine.count({ where: { payoutId: payout.id } })).resolves.toBe(0);
  });

  it('確定したあとは作り直せない', async () => {
    /*
      ⚠️ **締めたあとに金額が動くと、作家さまへ渡した明細と食い違う。**
         訂正は次の期間での調整で行う。
    */
    const seeded = await seedCreator();
    const orderId = await seedPaidOrder(seeded);
    const payout = await repo.saveDraft(draftCommand(seeded, [orderId]));
    await repo.advance({
      payoutId: payout.id,
      from: 'draft',
      to: 'confirmed',
      actorAccountId: seeded.creatorAccountId,
      now: NOW,
    });

    await expect(repo.saveDraft(draftCommand(seeded, [orderId]))).rejects.toThrow();
  });
});

suite('候補の絞り込み', () => {
  it('返金された注文は入れない', async () => {
    const seeded = await seedCreator();
    await seedPaidOrder(seeded, { refundStatus: 'refunded' });
    await expect(
      repo.listCandidates({
        creatorAccountId: seeded.creatorAccountId,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
      }),
    ).resolves.toHaveLength(0);
  });

  it('一部返金の注文も入れない', async () => {
    // ⚠️ いくら渡すかは、返した額を差し引いてから決める話。機械が案分しない。
    const seeded = await seedCreator();
    await seedPaidOrder(seeded, { refundStatus: 'partially_refunded' });
    await expect(
      repo.listCandidates({
        creatorAccountId: seeded.creatorAccountId,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
      }),
    ).resolves.toHaveLength(0);
  });

  it('期間の外の注文は入れない（半開区間）', async () => {
    const seeded = await seedCreator();
    // JST 9/1 0 時ちょうど = 次の期間。
    await seedPaidOrder(seeded, { paidAt: PERIOD_END });
    await expect(
      repo.listCandidates({
        creatorAccountId: seeded.creatorAccountId,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
      }),
    ).resolves.toHaveLength(0);
  });

  /*
    決着待ちのご注文を拾い直す（決定 B・2026-08-22）。

    ⚠️ **これが B のいちばん危ない部分である。** 争いのあるご注文は下書きから
       外すので、候補を「その期間に入金された」で絞ったままにすると、
       外したご注文が**二度と候補に上がらない**——翌月は翌月に入金された
       ご注文しか見ないため、作家さまへ永久にお支払いされない。
  */
  it('前の期間に入金され、まだ精算に載っていない注文は、次の期間の候補に上がる', async () => {
    const seeded = await seedCreator();
    // ⚠️ 8 月に入金。8 月の精算では争いのため外されたもの、という想定。
    await seedPaidOrder(seeded, { paidAt: new Date('2026-08-10T00:00:00.000Z') });
    // 9 月の期間で数える。
    await expect(
      repo.listCandidates({
        creatorAccountId: seeded.creatorAccountId,
        periodStart: PERIOD_END,
        periodEnd: new Date('2026-09-30T15:00:00.000Z'),
      }),
    ).resolves.toHaveLength(1);
  });

  it('争いのあるご注文は isUnderDispute が立って返る', async () => {
    const seeded = await seedCreator();
    const orderId = await seedPaidOrder(seeded);
    await seedDispute(orderId, 'needs_response');
    const rows = await repo.listCandidates({
      creatorAccountId: seeded.creatorAccountId,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.isUnderDispute).toBe(true);
  });

  it('警告だけでは isUnderDispute が立たない', async () => {
    /*
      ⚠️ **警告は申し立てではない。** カード会社が調べ始めただけで、
         そのまま消えることもある。外すと、消えた警告のぶんまで作家さまへの
         お支払いが理由なく遅れる。
    */
    const seeded = await seedCreator();
    const orderId = await seedPaidOrder(seeded);
    await seedDispute(orderId, 'warning');
    const rows = await repo.listCandidates({
      creatorAccountId: seeded.creatorAccountId,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    });
    expect(rows[0]?.isUnderDispute).toBe(false);
  });

  it('決着した争いでは isUnderDispute が立たない', async () => {
    const seeded = await seedCreator();
    const orderId = await seedPaidOrder(seeded);
    await seedDispute(orderId, 'won');
    const rows = await repo.listCandidates({
      creatorAccountId: seeded.creatorAccountId,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    });
    expect(rows[0]?.isUnderDispute).toBe(false);
  });

  it('境界の直前は入る', async () => {
    const seeded = await seedCreator();
    await seedPaidOrder(seeded, { paidAt: new Date(PERIOD_END.getTime() - 1) });
    await expect(
      repo.listCandidates({
        creatorAccountId: seeded.creatorAccountId,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
      }),
    ).resolves.toHaveLength(1);
  });

  it('すでに精算に載っている注文は入れない', async () => {
    const seeded = await seedCreator();
    const orderId = await seedPaidOrder(seeded);
    await repo.saveDraft(draftCommand(seeded, [orderId]));

    await expect(
      repo.listCandidates({
        creatorAccountId: seeded.creatorAccountId,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
      }),
    ).resolves.toHaveLength(0);
  });

  it('注文時点の作品名を持ち出す（マスタを引き直さない）', async () => {
    const seeded = await seedCreator();
    await seedPaidOrder(seeded);
    await prisma.artwork.update({
      where: { id: seeded.artworkId },
      data: { title: '改名したあとの名前' },
    });

    const candidates = await repo.listCandidates({
      creatorAccountId: seeded.creatorAccountId,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    });
    expect(candidates[0]?.artworkTitleSnapshot).toBe('精算の試験の作品');
  });
});

suite('返金の窓と繰越', () => {
  it('窓が開いている注文を、この精算の明細から数える', async () => {
    /*
      ⚠️ **候補の絞り込みで数えない。** あちらは「まだどの精算にも載って
         いない注文」を返すので、下書きを保存した直後は 0 件になる。
    */
    const seeded = await seedCreator();
    const orderId = await seedPaidOrder(seeded, {
      refundableUntil: new Date('2026-09-25T00:00:00.000Z'),
    });
    const payout = await repo.saveDraft(draftCommand(seeded, [orderId]));

    await expect(repo.countOpenRefundWindows(payout.id, NOW)).resolves.toBe(1);
  });

  it('期限が付いていない注文も「開いている」と数える', async () => {
    const seeded = await seedCreator();
    const orderId = await seedPaidOrder(seeded, { refundableUntil: null });
    const payout = await repo.saveDraft(draftCommand(seeded, [orderId]));
    await expect(repo.countOpenRefundWindows(payout.id, NOW)).resolves.toBe(1);
  });

  it('閉じていれば 0', async () => {
    const seeded = await seedCreator();
    const orderId = await seedPaidOrder(seeded);
    const payout = await repo.saveDraft(draftCommand(seeded, [orderId]));
    await expect(repo.countOpenRefundWindows(payout.id, NOW)).resolves.toBe(0);
  });

  it('下書きのままの前月から繰り越さない（金額がまだ動く）', async () => {
    const seeded = await seedCreator();
    const orderId = await seedPaidOrder(seeded);
    await repo.saveDraft(
      draftCommand(seeded, [orderId], { periodKey: '2026-07', carriedOutAmount: 800 }),
    );
    await expect(repo.carriedInAmount(seeded.creatorAccountId, '2026-07')).resolves.toBe(0);
  });

  it('確定した前月からは繰り越す', async () => {
    const seeded = await seedCreator();
    const orderId = await seedPaidOrder(seeded);
    const previous = await repo.saveDraft(
      draftCommand(seeded, [orderId], { periodKey: '2026-07', carriedOutAmount: 800 }),
    );
    await repo.advance({
      payoutId: previous.id,
      from: 'draft',
      to: 'confirmed',
      actorAccountId: seeded.creatorAccountId,
      now: NOW,
    });
    await expect(repo.carriedInAmount(seeded.creatorAccountId, '2026-07')).resolves.toBe(800);
  });
});

suite('差し戻しの洗い出し', () => {
  /**
   * 返金の行を 1 つ置く。
   *
   * ⚠️ **`refund_status` を書き換えるだけでは足りない**（決定 2026-08-22）。
   * 誰が被るかも、いくら返したかも、返金の行にしか無い。以前はここを見て
   * いなかったので、**こちらの不具合で返金した分まで作家さまから引いていた**。
   */
  async function seedRefund(
    orderId: string,
    input: { amount: number; bearer: 'platform' | 'creator'; status?: string },
  ): Promise<void> {
    await prisma.refund.create({
      data: {
        id: randomUUID(),
        orderId,
        amount: input.amount,
        currency: 'JPY',
        reason: input.bearer === 'creator' ? 'buyer_request' : 'our_fault',
        initiatedBy: 'admin',
        clawbackBearer: input.bearer,
        status: input.status ?? 'succeeded',
        settledAt: (input.status ?? 'succeeded') === 'succeeded' ? NOW : null,
      },
    });
    await prisma.order.update({
      where: { id: orderId },
      data: { refundStatus: input.amount >= 12000 ? 'refunded' : 'partially_refunded' },
    });
  }

  /** 確定済みの精算を 1 件作る。 */
  async function confirmedPayout(seeded: Seeded, orderId: string) {
    const payout = await repo.saveDraft(draftCommand(seeded, [orderId]));
    await repo.advance({
      payoutId: payout.id,
      from: 'draft',
      to: 'confirmed',
      actorAccountId: seeded.creatorAccountId,
      now: NOW,
    });
    return payout;
  }

  it('確定済みの精算に載っていた注文が返金されたら拾う', async () => {
    const seeded = await seedCreator();
    const orderId = await seedPaidOrder(seeded);
    await confirmedPayout(seeded, orderId);
    await seedRefund(orderId, { amount: 12000, bearer: 'creator' });

    const clawbacks = await repo.listClawbacks(seeded.creatorAccountId);
    expect(clawbacks).toHaveLength(1);
    // ⚠️ 正の数で返す。符号はドメイン側が付ける。
    expect(clawbacks[0]?.netAmount).toBe(9600);
  });

  /*
    ⚠️ **この試験が、この変更のいちばんの主題。** 以前は事由を見ずに拾って
       いたので、**こちらの不具合で返金した分まで作家さまの次回の売上から
       引いていた**。作家さまはお渡ししている。
  */
  it('運営が被る返金は拾わない（こちらの落ち度・チャージバック）', async () => {
    const seeded = await seedCreator();
    const orderId = await seedPaidOrder(seeded);
    await confirmedPayout(seeded, orderId);
    await seedRefund(orderId, { amount: 12000, bearer: 'platform' });

    await expect(repo.listClawbacks(seeded.creatorAccountId)).resolves.toHaveLength(0);
  });

  it('成立していない返金は拾わない', async () => {
    // ⚠️ 事業者へ投げただけで、まだ返っていない。取り立てる根拠が無い。
    const seeded = await seedCreator();
    const orderId = await seedPaidOrder(seeded);
    await confirmedPayout(seeded, orderId);
    await seedRefund(orderId, { amount: 12000, bearer: 'creator', status: 'requested' });

    await expect(repo.listClawbacks(seeded.creatorAccountId)).resolves.toHaveLength(0);
  });

  it('下書きのままの精算は拾わない（まだ払っていない）', async () => {
    const seeded = await seedCreator();
    const orderId = await seedPaidOrder(seeded);
    await repo.saveDraft(draftCommand(seeded, [orderId]));
    await seedRefund(orderId, { amount: 12000, bearer: 'creator' });

    await expect(repo.listClawbacks(seeded.creatorAccountId)).resolves.toHaveLength(0);
  });

  /*
    ⚠️ **二つ目の主題。** 以前は注文の作家さま配分を丸ごと引いていた。
       一部返金ができるようになった以上、それでは**返していない分まで
       取り立てる**ことになる。
  */
  it('一部返金は、返した額の作家さま配分だけを引く', async () => {
    const seeded = await seedCreator();
    const orderId = await seedPaidOrder(seeded);
    await confirmedPayout(seeded, orderId);
    // 12000 円のうち 3000 円を返金。手数料 20% なので作家さま配分は 2400 円。
    await seedRefund(orderId, { amount: 3000, bearer: 'creator' });

    const clawbacks = await repo.listClawbacks(seeded.creatorAccountId);
    expect(clawbacks).toHaveLength(1);
    expect(clawbacks[0]?.netAmount).toBe(2400);
  });

  it('一度差し引いた注文を二度拾わない', async () => {
    // ⚠️ 二度引くと、作家さまから取りすぎる。
    const seeded = await seedCreator();
    const orderId = await seedPaidOrder(seeded);
    const payout = await confirmedPayout(seeded, orderId);
    await seedRefund(orderId, { amount: 12000, bearer: 'creator' });
    await prisma.payoutLine.create({
      data: {
        id: randomUUID(),
        payoutId: payout.id,
        orderId,
        orderNumber: 'SNK-0001',
        artworkTitleSnapshot: '精算の試験の作品',
        grossAmount: 0,
        feeRateBps: 0,
        feeAmount: 0,
        netAmount: -9600,
        isClawback: true,
      },
    });

    await expect(repo.listClawbacks(seeded.creatorAccountId)).resolves.toHaveLength(0);
  });

  it('月をまたいだ 2 度目の一部返金は、差分だけを拾う', async () => {
    /*
      ⚠️ **「差し戻しの行があれば対象外」では、2 度目が拾えない。** 同じ
         注文が月をまたいで 2 度返金されることがある。引くべき合計と、
         引いた合計の差を見る。
    */
    const seeded = await seedCreator();
    const orderId = await seedPaidOrder(seeded);
    const payout = await confirmedPayout(seeded, orderId);
    await seedRefund(orderId, { amount: 3000, bearer: 'creator' });
    await prisma.payoutLine.create({
      data: {
        id: randomUUID(),
        payoutId: payout.id,
        orderId,
        orderNumber: 'SNK-0001',
        artworkTitleSnapshot: '精算の試験の作品',
        grossAmount: 0,
        feeRateBps: 0,
        feeAmount: 0,
        netAmount: -2400,
        isClawback: true,
      },
    });
    // さらに 3000 円を返金。合計 6000 円 → 作家さま配分 4800 円。
    await seedRefund(orderId, { amount: 3000, bearer: 'creator' });

    const clawbacks = await repo.listClawbacks(seeded.creatorAccountId);
    expect(clawbacks).toHaveLength(1);
    // ⚠️ 4800 − すでに引いた 2400 ＝ 2400。
    expect(clawbacks[0]?.netAmount).toBe(2400);
  });

  it('もとの作家さま配分を超えて引かない', async () => {
    /*
      ⚠️ **端数の丸めが積み上がると、払った額より多く取り立てうる。**
         3 回に分けた一部返金の作家さま配分の合計は、一度に返した場合の
         配分をわずかに上回ることがある（切り捨てが 3 回に分かれるため）。
    */
    const seeded = await seedCreator();
    const orderId = await seedPaidOrder(seeded);
    await confirmedPayout(seeded, orderId);
    for (const amount of [4001, 4001, 3998]) {
      await seedRefund(orderId, { amount, bearer: 'creator' });
    }

    const clawbacks = await repo.listClawbacks(seeded.creatorAccountId);
    expect(clawbacks).toHaveLength(1);
    expect(clawbacks[0]?.netAmount).toBe(9600);
  });

  it('運営負担と作家さま負担が混ざったら、作家さま負担だけを引く', async () => {
    const seeded = await seedCreator();
    const orderId = await seedPaidOrder(seeded);
    await confirmedPayout(seeded, orderId);
    await seedRefund(orderId, { amount: 3000, bearer: 'creator' });
    await seedRefund(orderId, { amount: 5000, bearer: 'platform' });

    const clawbacks = await repo.listClawbacks(seeded.creatorAccountId);
    expect(clawbacks).toHaveLength(1);
    // ⚠️ 3000 円分だけ。運営が被った 5000 円は作家さまへ回さない。
    expect(clawbacks[0]?.netAmount).toBe(2400);
  });
});
