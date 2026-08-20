import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import {
  buildRevokedEvent,
  revocationEventId,
  type RevocationPlan,
  type RevocationPlanInput,
} from '@sengoku/domain';
import type { PrismaClient } from '../../generated/client';
import { PrismaOperationsReviewRepository } from '../../src/repositories/operations-review.repository';
import { PrismaPayoutRepository } from '../../src/repositories/payout.repository';
import { PrismaRefundRepository } from '../../src/repositories/refund.repository';
import { PrismaRevocationReconcileRepository } from '../../src/repositories/revocation-reconcile.repository';
import { PrismaWalletDeliveryOutboxRepository } from '../../src/repositories/wallet-delivery.repository';
import {
  createTestClient,
  integrationTestsAvailable,
  orderLineSeedFields,
  orderSeedFields,
  resetDatabase,
  violatesConstraint,
} from '../helpers/database';

/**
 * 全額返金にともなう取り消し（`UD-104` 追補・2026-08-20 決定）。
 *
 * ⚠️ ここで見たいのは、アプリの判定に穴が開いたときに**残る最後の砦**。
 *   1. 受取済みを `revoked` にしても、受取記録と配送記録が**残る**こと
 *   2. `issued` / `expired` に claim 情報を残せないままであること
 *   3. claim 日時と claim アカウントが**片方だけ**にならないこと
 *   4. 重複・並行した返金でも、取消イベントが**1 件だけ**であること
 *   5. その重複で**返金そのものが巻き戻らない**こと
 *   6. 相手が知らない受取権へ取消を送らないこと
 */
const enabled = integrationTestsAvailable();
const suite = enabled ? describe : describe.skip;

const NOW = new Date('2026-08-21T00:00:00.000Z');
const SETTLED_AT = new Date('2026-08-21T09:00:00.000Z');
const PURCHASER_CU = 'cu_0123456789abcdef0123456789abcdef';
const OTHER_CU = 'cu_ffffffffffffffffffffffffffffffff';
const CORRELATION_ID = 'corr_0123456789';

let prisma: PrismaClient;
let refunds: PrismaRefundRepository;
let outbox: PrismaWalletDeliveryOutboxRepository;
let reviews: PrismaOperationsReviewRepository;
let reconcile: PrismaRevocationReconcileRepository;
let payouts: PrismaPayoutRepository;

function hashOf(payload: string): string {
  return `sha256:${createHash('sha256').update(payload, 'utf8').digest('hex')}`;
}

/**
 * 取消の本文を組み立てる。
 *
 * ⚠️ **API 側と同じ組み立て方にする。** 別々に書くと、同じ受取権でも
 * 経路によって本文が変わり、正常な重複が「食い違い」として検知される。
 */
function planRevocation(input: RevocationPlanInput): RevocationPlan {
  const event = buildRevokedEvent({
    eventId: input.eventId,
    occurredAt: input.occurredAt,
    correlationId: input.correlationId,
    commonUserId: input.commonUserId,
    entitlementId: input.entitlementId,
    orderId: input.orderId,
    orderLineId: input.orderLineId,
    artworkId: input.artworkId,
    reasonCode: 'full_refund',
  });
  if (!event.ok) {
    throw new Error(event.error.code);
  }
  const payload = JSON.stringify(event.value);
  return {
    eventId: event.value.event_id,
    payload,
    payloadHash: hashOf(payload),
    correlationId: input.correlationId,
  };
}

beforeAll(async () => {
  if (!enabled) return;
  prisma = createTestClient();
  await prisma.$connect();
  refunds = new PrismaRefundRepository(prisma);
  outbox = new PrismaWalletDeliveryOutboxRepository(prisma);
  reviews = new PrismaOperationsReviewRepository(prisma);
  reconcile = new PrismaRevocationReconcileRepository(prisma);
  payouts = new PrismaPayoutRepository(prisma);
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
  readonly artworkId: string;
  readonly accountId: string;
  readonly paymentId: string;
  readonly entitlementId: string;
}

/** 支払い済みの注文と、受取権 1 枚を作る。 */
async function seedPaidOrder(
  options: { readonly claimed?: boolean; readonly delivered?: boolean } = {},
): Promise<Seeded> {
  const accountId = randomUUID();
  await prisma.account.create({
    data: {
      id: accountId,
      authProvider: 'fake',
      authSubject: accountId,
      commonUserId: PURCHASER_CU,
      commonUserStatus: 'RESOLVED',
      commonUserLinkedAt: NOW,
    },
  });
  const artwork = await prisma.artwork.create({
    data: {
      creatorAccountId: accountId,
      slug: `artwork-${randomUUID()}`,
      title: '取り消しの試験の作品',
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
      ...orderSeedFields({ creatorAccountId: accountId, totalAmount: 3000 }),
    },
  });
  const line = await prisma.orderLine.create({
    data: {
      orderId: order.id,
      listingId: listing.id,
      artworkId: artwork.id,
      artworkTitleSnapshot: '取り消しの試験の作品',
      unitPriceAmount: 3000,
      unitPriceCurrency: 'JPY',
      quantity: 1,
      ...orderLineSeedFields({ creatorAccountId: accountId, unitPriceAmount: 3000, quantity: 1 }),
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
  await prisma.inventoryReservation.create({
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
  const claimed = options.claimed ?? false;
  const delivered = options.delivered ?? false;
  const entitlement = await prisma.entitlement.create({
    data: {
      orderId: order.id,
      orderLineId: line.id,
      artworkId: artwork.id,
      accountId,
      serialNo: 1,
      unitIndex: 0,
      claimTokenHash: randomUUID(),
      status: claimed ? 'claimed' : 'issued',
      ...(claimed
        ? {
            claimedByAccountId: accountId,
            claimedByCommonUserId: PURCHASER_CU,
            claimedAt: NOW,
            walletDeliveryStatus: delivered ? 'delivered' : 'pending',
            ...(delivered ? { walletDeliveredAt: NOW } : {}),
          }
        : {}),
    },
  });
  return {
    orderId: order.id,
    orderLineId: line.id,
    artworkId: artwork.id,
    accountId,
    paymentId: payment.id,
    entitlementId: entitlement.id,
  };
}

/** 付与イベントを 1 件積む（＝相手が知っている状態にする）。 */
async function seedGranted(
  seeded: Seeded,
  overrides: { readonly commonUserId?: string | null; readonly status?: string } = {},
): Promise<void> {
  const commonUserId = overrides.commonUserId === undefined ? PURCHASER_CU : overrides.commonUserId;
  const payload = JSON.stringify({
    event_type: 'entitlement.granted',
    event_version: '1.0',
    ...(commonUserId === null ? {} : { common_user_id: commonUserId }),
  });
  await outbox.enqueue({
    eventId: `evt_${randomUUID()}`,
    eventType: 'entitlement.granted',
    entitlementId: seeded.entitlementId,
    targetSiteKey: 'ovew-wallet',
    payload,
    payloadHash: hashOf(payload),
    correlationId: CORRELATION_ID,
    now: NOW,
  });
  if (overrides.status !== undefined && overrides.status !== 'PENDING') {
    await prisma.walletDeliveryOutbox.updateMany({
      where: { entitlementId: seeded.entitlementId, eventType: 'entitlement.granted' },
      data: { status: overrides.status as 'DELIVERED', deliveredAt: NOW },
    });
  }
}

async function startAndSettle(
  seeded: Seeded,
  options: {
    readonly revokeClaimed?: boolean;
    readonly generate?: boolean;
    readonly amount?: number;
    readonly revokeEntitlement?: boolean;
  } = {},
) {
  const refund = await refunds.start({
    refundId: randomUUID(),
    orderId: seeded.orderId,
    paymentId: seeded.paymentId,
    amount: options.amount ?? 3000,
    currency: 'JPY',
    reason: 'buyer_request',
    initiatedBy: 'admin',
    actorAccountId: seeded.accountId,
    providerRefundRef: null,
    note: null,
    now: NOW,
  });
  const settlement = await refunds.settle({
    refundId: refund.id,
    orderId: seeded.orderId,
    providerRefundRef: `re_${randomUUID()}`,
    amountRefundedTotal: options.amount ?? 3000,
    revokeEntitlement: options.revokeEntitlement ?? true,
    cancelMintJob: false,
    mintNote: null,
    revokeClaimedEntitlements: options.revokeClaimed ?? true,
    planRevocation: (options.generate ?? true) ? planRevocation : null,
    now: SETTLED_AT,
  });
  return { refund, settlement };
}

suite('CHECK 制約 — 取り消しても記録は残る', () => {
  it('受取済みを revoked にしても、受取記録と配送記録が残る', async () => {
    const seeded = await seedPaidOrder({ claimed: true, delivered: true });

    await prisma.entitlement.update({
      where: { id: seeded.entitlementId },
      data: { status: 'revoked' },
    });

    const row = await prisma.entitlement.findUniqueOrThrow({
      where: { id: seeded.entitlementId },
    });
    expect(row.status).toBe('revoked');
    // ⚠️ 受け取った事実は消さない。消えると、あとから経緯を説明できない。
    expect(row.claimedAt).not.toBeNull();
    expect(row.claimedByAccountId).not.toBeNull();
    expect(row.claimedByCommonUserId).toBe(PURCHASER_CU);
    expect(row.walletDeliveryStatus).toBe('delivered');
    expect(row.walletDeliveredAt).not.toBeNull();
  });

  it('claim 日時だけを残した行は作れない', async () => {
    // ⚠️ 「誰が受け取ったか分からないが、受け取った時刻はある」を作らせない。
    const seeded = await seedPaidOrder({ claimed: true });
    await expect(
      prisma.entitlement.update({
        where: { id: seeded.entitlementId },
        data: { status: 'revoked', claimedByAccountId: null },
      }),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'entitlements_claim_fields_paired'),
    );
  });

  it('claim アカウントだけを残した行も作れない', async () => {
    const seeded = await seedPaidOrder({ claimed: true });
    await expect(
      prisma.entitlement.update({
        where: { id: seeded.entitlementId },
        data: { status: 'revoked', claimedAt: null },
      }),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'entitlements_claim_fields_paired'),
    );
  });

  it('issued に claim 情報は残せないまま', async () => {
    const seeded = await seedPaidOrder();
    await expect(
      prisma.entitlement.update({
        where: { id: seeded.entitlementId },
        data: { claimedAt: NOW, claimedByAccountId: seeded.accountId },
      }),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'entitlements_claim_fields_require_claim_or_revoked'),
    );
  });

  it('issued に配送情報も残せないまま', async () => {
    const seeded = await seedPaidOrder();
    await expect(
      prisma.entitlement.update({
        where: { id: seeded.entitlementId },
        data: { walletDeliveryStatus: 'pending' },
      }),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'entitlements_delivery_requires_claim'),
    );
  });

  it('claimed には受取者が必須のまま', async () => {
    const seeded = await seedPaidOrder({ claimed: true });
    await expect(
      prisma.entitlement.update({
        where: { id: seeded.entitlementId },
        data: { claimedAt: null, claimedByAccountId: null },
      }),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'entitlements_claimed_fields_present'),
    );
  });
});

suite('全額返金の取り消しと知らせ', () => {
  it('未受取で付与イベントも無ければ、取消の知らせは作らない', async () => {
    /*
      ⚠️ **相手が知らない受取権の取消を送らない。** 送ると相手には
         「知らないIDの取消」が届き続ける。
    */
    const seeded = await seedPaidOrder();

    const { settlement } = await startAndSettle(seeded);

    expect(settlement.revokedEntitlements).toBe(1);
    expect(settlement.revocationEventsCreated).toBe(0);
    const rows = await prisma.walletDeliveryOutbox.findMany({
      where: { eventType: 'entitlement.revoked' },
    });
    expect(rows).toHaveLength(0);
    const entitlement = await prisma.entitlement.findUniqueOrThrow({
      where: { id: seeded.entitlementId },
    });
    expect(entitlement.status).toBe('revoked');
  });

  it('付与イベントがあれば、未受取でも取消の知らせを 1 件作る', async () => {
    // 送信待ちのまま返金された分が、永久に取り消されないことを防ぐ。
    const seeded = await seedPaidOrder({ claimed: true });
    await seedGranted(seeded);

    const { settlement } = await startAndSettle(seeded);

    expect(settlement.revocationEventsCreated).toBe(1);
    const rows = await prisma.walletDeliveryOutbox.findMany({
      where: { eventType: 'entitlement.revoked' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventId).toBe(revocationEventId(seeded.entitlementId));
  });

  it('受取済みを取り消し、受取記録も配送記録も残す', async () => {
    const seeded = await seedPaidOrder({ claimed: true, delivered: true });
    await seedGranted(seeded, { status: 'DELIVERED' });

    const { settlement } = await startAndSettle(seeded);

    expect(settlement.revokedEntitlements).toBe(1);
    expect(settlement.revocationEventsCreated).toBe(1);
    const row = await prisma.entitlement.findUniqueOrThrow({
      where: { id: seeded.entitlementId },
    });
    expect(row.status).toBe('revoked');
    expect(row.claimedAt).not.toBeNull();
    expect(row.claimedByCommonUserId).toBe(PURCHASER_CU);
    expect(row.walletDeliveredAt).not.toBeNull();
  });

  it('切り替えていなければ、受取済みは取り消さない', async () => {
    const seeded = await seedPaidOrder({ claimed: true });
    await seedGranted(seeded);

    const { settlement } = await startAndSettle(seeded, { revokeClaimed: false });

    expect(settlement.revokedEntitlements).toBe(0);
    const row = await prisma.entitlement.findUniqueOrThrow({
      where: { id: seeded.entitlementId },
    });
    expect(row.status).toBe('claimed');
  });

  it('生成フラグが無効なら、取り消すが知らせは作らない', async () => {
    const seeded = await seedPaidOrder({ claimed: true });
    await seedGranted(seeded);

    const { settlement } = await startAndSettle(seeded, { generate: false });

    expect(settlement.revokedEntitlements).toBe(1);
    expect(settlement.revocationEventsCreated).toBe(0);
    // ⚠️ 知らせを作らないなら、付与にも触らない。あとで補完がまとめて行う。
    const granted = await prisma.walletDeliveryOutbox.findFirstOrThrow({
      where: { eventType: 'entitlement.granted' },
    });
    expect(granted.status).toBe('PENDING');
  });

  it('未配送の付与は、送らないことにする（取り消しに追い越された）', async () => {
    /*
      ⚠️ **これをしないと、取り消したはずの作品があとから相手側に現れる。**
    */
    const seeded = await seedPaidOrder({ claimed: true });
    await seedGranted(seeded);

    const { settlement } = await startAndSettle(seeded);

    expect(settlement.supersededGrantedEvents).toBe(1);
    const granted = await prisma.walletDeliveryOutbox.findFirstOrThrow({
      where: { eventType: 'entitlement.granted' },
    });
    expect(granted.status).toBe('SUPERSEDED');
    // ⚠️ 行は消さない。「送ろうとしていた」事実は残す。
    expect(granted.payload.length).toBeGreaterThan(0);
  });

  it('送信中の付与は追い越さない（届いたか分からないため）', async () => {
    const seeded = await seedPaidOrder({ claimed: true });
    await seedGranted(seeded);
    await prisma.walletDeliveryOutbox.updateMany({
      where: { eventType: 'entitlement.granted' },
      data: { status: 'PROCESSING' },
    });

    const { settlement } = await startAndSettle(seeded);

    expect(settlement.supersededGrantedEvents).toBe(0);
    const granted = await prisma.walletDeliveryOutbox.findFirstOrThrow({
      where: { eventType: 'entitlement.granted' },
    });
    expect(granted.status).toBe('PROCESSING');
  });

  it('宛先が決まらなければ、推測せず運用確認へ回す', async () => {
    const seeded = await seedPaidOrder();
    // 付与は送ったのに、本文にも列にも共通顧客IDが無い（記録の食い違い）。
    await seedGranted(seeded, { commonUserId: null });

    const { settlement } = await startAndSettle(seeded);

    expect(settlement.revocationsNeedingReview).toHaveLength(1);
    expect(settlement.revocationEventsCreated).toBe(0);
    const rows = await reviews.list({
      statuses: ['open'],
      reasonCodes: ['wallet_revocation_recipient_unresolved'],
      cursor: null,
      limit: 10,
    });
    expect(rows.items).toHaveLength(1);
    expect(rows.items[0]?.subjectId).toBe(seeded.entitlementId);
  });

  it('付与の本文にある共通顧客IDを正とする', async () => {
    /*
      ⚠️ **列より本文。** 相手へ実際に伝えた値でないと、別人の Holding を
         消しにいく。
    */
    const seeded = await seedPaidOrder({ claimed: true });
    await seedGranted(seeded, { commonUserId: OTHER_CU });

    await startAndSettle(seeded);

    const row = await prisma.walletDeliveryOutbox.findFirstOrThrow({
      where: { eventType: 'entitlement.revoked' },
    });
    expect(JSON.parse(row.payload)).toMatchObject({ common_user_id: OTHER_CU });
  });

  it('取消の本文に金額・氏名・メールを含めない', async () => {
    const seeded = await seedPaidOrder({ claimed: true });
    await seedGranted(seeded);

    await startAndSettle(seeded);

    const row = await prisma.walletDeliveryOutbox.findFirstOrThrow({
      where: { eventType: 'entitlement.revoked' },
    });
    // ⚠️ 金額・氏名・メール・住所の項目そのものを持たない。
    for (const forbidden of ['amount', 'email', 'address', 'buyer_name', 'refund_amount']) {
      expect(row.payload).not.toContain(forbidden);
    }
    const parsed: unknown = JSON.parse(row.payload);
    expect(parsed).toMatchObject({ event_version: '1.1', reason_code: 'full_refund' });
    // 表示情報も載せない（相手が Holding を書き換える余地を作らない）。
    expect(Object.keys(parsed as Record<string, unknown>)).not.toContain('metadata');
  });

  it('相関IDは付与から引き継ぐ', async () => {
    const seeded = await seedPaidOrder({ claimed: true });
    await seedGranted(seeded);

    await startAndSettle(seeded);

    const row = await prisma.walletDeliveryOutbox.findFirstOrThrow({
      where: { eventType: 'entitlement.revoked' },
    });
    expect(row.correlationId).toBe(CORRELATION_ID);
  });
});

suite('重複と並行', () => {
  it('同じ返金を 2 回反映しても、取消の知らせは 1 件だけ', async () => {
    const seeded = await seedPaidOrder({ claimed: true });
    await seedGranted(seeded);
    const refund = await refunds.start({
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
    });
    const command = {
      refundId: refund.id,
      orderId: seeded.orderId,
      providerRefundRef: 're_dup',
      amountRefundedTotal: 3000,
      revokeEntitlement: true,
      cancelMintJob: false,
      mintNote: null,
      revokeClaimedEntitlements: true,
      planRevocation,
      now: SETTLED_AT,
    };

    const first = await refunds.settle(command);
    const second = await refunds.settle(command);

    expect(first.revocationEventsCreated).toBe(1);
    // ⚠️ 2 度目は何もしない。返金も取消も二重にならない。
    expect(second.alreadySettled).toBe(true);
    expect(second.revocationEventsCreated).toBe(0);
    const rows = await prisma.walletDeliveryOutbox.findMany({
      where: { eventType: 'entitlement.revoked' },
    });
    expect(rows).toHaveLength(1);
  });

  it('別の返金として 2 度届いても、取消の知らせは 1 件だけ（返金は成功する）', async () => {
    /*
      ⚠️ **ここが素の INSERT だと、UNIQUE 違反で返金ごと巻き戻る。**
         返金は決済事業者へ既に届いているのに、こちらの記録だけが消える。
    */
    const seeded = await seedPaidOrder({ claimed: true });
    await seedGranted(seeded);

    const first = await startAndSettle(seeded);
    // 1 件目で revoked になっているので、2 件目は取り消す対象を持たない。
    // それでも取消の知らせを積み直そうとしたときに落ちないことを確かめる。
    await prisma.entitlement.update({
      where: { id: seeded.entitlementId },
      data: { status: 'claimed' },
    });
    const second = await startAndSettle(seeded);

    expect(first.settlement.revocationEventsCreated).toBe(1);
    // 同じ本文なので冪等成功。⚠️ 例外にならないことが肝心。
    expect(second.settlement.revocationEventsDuplicate).toBe(1);
    expect(second.settlement.alreadySettled).toBe(false);
    const rows = await prisma.walletDeliveryOutbox.findMany({
      where: { eventType: 'entitlement.revoked' },
    });
    expect(rows).toHaveLength(1);
  });

  it('同じイベントIDで本文が違えば、無言で成功にせず運用確認へ回す', async () => {
    const seeded = await seedPaidOrder({ claimed: true });
    await seedGranted(seeded);
    // 先に「別の本文」で同じイベントIDの行を作っておく。
    const stalePayload = JSON.stringify({ event_type: 'entitlement.revoked', stale: true });
    await outbox.enqueue({
      eventId: revocationEventId(seeded.entitlementId),
      eventType: 'entitlement.revoked',
      entitlementId: seeded.entitlementId,
      targetSiteKey: 'ovew-wallet',
      payload: stalePayload,
      payloadHash: hashOf(stalePayload),
      correlationId: CORRELATION_ID,
      now: NOW,
    });

    const { settlement } = await startAndSettle(seeded);

    // ⚠️ 返金は成立する。整合性の異常で巻き戻さない。
    expect(settlement.alreadySettled).toBe(false);
    expect(settlement.revocationPayloadConflicts).toHaveLength(1);
    const open = await reviews.list({
      statuses: ['open'],
      reasonCodes: ['wallet_revocation_payload_conflict'],
      cursor: null,
      limit: 10,
    });
    expect(open.items).toHaveLength(1);
  });

  it('運用確認は、同じ対象・同じ理由で 2 行にならない', async () => {
    const seeded = await seedPaidOrder();
    const command = {
      subjectType: 'entitlement' as const,
      subjectId: seeded.entitlementId,
      orderId: seeded.orderId,
      reasonCode: 'wallet_revocation_recipient_unresolved' as const,
      detail: '宛先が決まりませんでした。',
      now: NOW,
    };

    expect(await reviews.open(command)).toBe(true);
    expect(await reviews.open({ ...command, detail: 'あとから来た別の文言' })).toBe(false);

    const page = await reviews.list({ statuses: [], reasonCodes: [], cursor: null, limit: 10 });
    expect(page.items).toHaveLength(1);
    // ⚠️ 上書きしない。最初に気づいた理由を残す。
    expect(page.items[0]?.detail).toBe('宛先が決まりませんでした。');
  });
});

suite('取りこぼしの補完', () => {
  it('生成を止めていた期間の分を、あとから拾える', async () => {
    const seeded = await seedPaidOrder({ claimed: true });
    await seedGranted(seeded);
    await startAndSettle(seeded, { generate: false });

    const missing = await reconcile.listMissing(10);

    expect(missing).toHaveLength(1);
    expect(missing[0]?.entitlementId).toBe(seeded.entitlementId);
    expect(missing[0]?.grantedCommonUserId).toBe(PURCHASER_CU);
    // ⚠️ 現在時刻ではなく、返金が成立した時刻。
    expect(missing[0]?.occurredAt.toISOString()).toBe(SETTLED_AT.toISOString());
  });

  it('相手が知らない受取権は、補完の対象にしない', async () => {
    const seeded = await seedPaidOrder();
    await startAndSettle(seeded, { generate: false });

    const missing = await reconcile.listMissing(10);

    expect(missing).toHaveLength(0);
  });

  it('すでに知らせがある分は、対象に出てこない', async () => {
    const seeded = await seedPaidOrder({ claimed: true });
    await seedGranted(seeded);
    await startAndSettle(seeded);

    const missing = await reconcile.listMissing(10);

    expect(missing).toHaveLength(0);
  });
});

suite('一部返金', () => {
  it('受取権を自動では取り消さない', async () => {
    /*
      ⚠️ **どのシリアルを取り消すべきかは機械に決められない。**
         数量や明細を指定して返金する経路が無い以上、推測で取り消さない。
    */
    const seeded = await seedPaidOrder({ claimed: true });
    await seedGranted(seeded);

    const { settlement } = await startAndSettle(seeded, {
      amount: 1000,
      revokeEntitlement: false,
    });

    expect(settlement.refundStatus).toBe('partially_refunded');
    expect(settlement.revokedEntitlements).toBe(0);
    expect(settlement.revocationEventsCreated).toBe(0);
    const row = await prisma.entitlement.findUniqueOrThrow({
      where: { id: seeded.entitlementId },
    });
    expect(row.status).toBe('claimed');
  });
});

suite('精算への影響（回帰）', () => {
  /**
   * ⚠️ **精算の正は `orders.refund_status`。** 受取権の状態ではない。
   * 取り消しを入れたことで、この関係が変わっていないことを確かめる。
   */
  async function listCandidates(seeded: Seeded) {
    const order = await prisma.order.findUniqueOrThrow({ where: { id: seeded.orderId } });
    return payouts.listCandidates({
      creatorAccountId: seeded.accountId,
      periodStart: new Date(order.paidAt!.getTime() - 86_400_000),
      periodEnd: new Date(order.paidAt!.getTime() + 86_400_000),
    });
  }

  it('返金前は精算の候補に入る', async () => {
    const seeded = await seedPaidOrder({ claimed: true });
    expect(await listCandidates(seeded)).toHaveLength(1);
  });

  it('全額返金すると候補から外れる（受取済みを取り消しても同じ）', async () => {
    const seeded = await seedPaidOrder({ claimed: true });
    await seedGranted(seeded);

    await startAndSettle(seeded);

    const entitlement = await prisma.entitlement.findUniqueOrThrow({
      where: { id: seeded.entitlementId },
    });
    expect(entitlement.status).toBe('revoked');
    // ⚠️ 取り消したから外れるのではない。返金の状態で外れる。
    expect(await listCandidates(seeded)).toHaveLength(0);
  });

  it('取り消しを切っていても、外れ方は変わらない', async () => {
    const seeded = await seedPaidOrder({ claimed: true });
    await seedGranted(seeded);

    await startAndSettle(seeded, { revokeClaimed: false });

    const entitlement = await prisma.entitlement.findUniqueOrThrow({
      where: { id: seeded.entitlementId },
    });
    expect(entitlement.status).toBe('claimed');
    expect(await listCandidates(seeded)).toHaveLength(0);
  });

  it('同じ返金が 2 度届いても、返金の累計は 1 回分', async () => {
    // ⚠️ 二重に積むと、差し戻しも二重になる。
    const seeded = await seedPaidOrder({ claimed: true });
    await seedGranted(seeded);
    const refund = await refunds.start({
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
    });
    const command = {
      refundId: refund.id,
      orderId: seeded.orderId,
      providerRefundRef: 're_twice',
      amountRefundedTotal: 3000,
      revokeEntitlement: true,
      cancelMintJob: false,
      mintNote: null,
      revokeClaimedEntitlements: true,
      planRevocation,
      now: SETTLED_AT,
    };

    await refunds.settle(command);
    await refunds.settle(command);

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: seeded.paymentId } });
    expect(payment.amountRefunded).toBe(3000);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: seeded.orderId } });
    expect(order.refundStatus).toBe('refunded');
  });

  it('配送の状態は精算に影響しない', async () => {
    /*
      ⚠️ Wallet へ届かなくても、返金と精算は独立に進む。
         相手の障害がこちらのお金の記録を止めない。
    */
    const seeded = await seedPaidOrder({ claimed: true });
    await seedGranted(seeded);
    await startAndSettle(seeded);

    // 取消の知らせを失敗させても、返金の状態は動かない。
    await prisma.walletDeliveryOutbox.updateMany({
      where: { eventType: 'entitlement.revoked' },
      data: { status: 'DEAD', lastErrorCode: 'http_503' },
    });

    const order = await prisma.order.findUniqueOrThrow({ where: { id: seeded.orderId } });
    expect(order.refundStatus).toBe('refunded');
    expect(await listCandidates(seeded)).toHaveLength(0);
  });
});
