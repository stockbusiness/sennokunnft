import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import type { PrismaClient } from '../../generated/client';
import { PrismaClaimRepository } from '../../src/repositories/claim.repository';
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
 * 配送待ち行列を実 PostgreSQL に対して確かめる。
 *
 * ⚠️ **ここを Fake で済ませない。**
 * 確かめたいのは次の 3 つで、いずれも DB の機能そのものが保証している。
 *  - 受取確定と行列への追加が**同一トランザクション**であること
 *  - `FOR UPDATE SKIP LOCKED` により**同じ行を 2 つのワーカーが掴まない**こと
 *  - CHECK 制約が「作れない」だけでなく「**残らない**」ことまで見ていること
 */
const enabled = integrationTestsAvailable();
const suite = enabled ? describe : describe.skip;

let prisma: PrismaClient;
let outbox: PrismaWalletDeliveryOutboxRepository;
let claims: PrismaClaimRepository;

const NOW = new Date('2026-08-14T00:00:00.000Z');
const PURCHASER_CU = 'cu_0123456789abcdef0123456789abcdef';
const CORRELATION_ID = 'corr_0123456789';

function hashOf(payload: string): string {
  return `sha256:${createHash('sha256').update(payload, 'utf8').digest('hex')}`;
}

beforeAll(async () => {
  if (!enabled) return;
  prisma = createTestClient();
  await prisma.$connect();
  outbox = new PrismaWalletDeliveryOutboxRepository(prisma);
  claims = new PrismaClaimRepository(prisma);
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
  entitlementId: string;
  accountId: string;
  tokenHash: string;
}

async function seedEntitlement(): Promise<Seeded> {
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
  // 作品には持ち主が要る。この試験の関心事ではないので購入者と同じ人にしておく。
  const artwork = await prisma.artwork.create({
    data: {
      creatorAccountId: accountId,
      slug: `artwork-${randomUUID()}`,
      title: '天下布武の陣羽織',
      maxSupply: 10,
      status: 'published',
    },
  });
  const order = await prisma.order.create({
    data: {
      accountId,
      totalAmount: 1000,
      totalCurrency: 'JPY',
      idempotencyKey: randomUUID(),
      ...orderSeedFields({ creatorAccountId: accountId, totalAmount: 1000 }),
    },
  });
  const listing = await prisma.listing.create({
    data: { artworkId: artwork.id, priceAmount: 1000, priceCurrency: 'JPY' },
  });
  const line = await prisma.orderLine.create({
    data: {
      orderId: order.id,
      listingId: listing.id,
      artworkId: artwork.id,
      artworkTitleSnapshot: '天下布武の陣羽織',
      unitPriceAmount: 1000,
      unitPriceCurrency: 'JPY',
      quantity: 1,
      ...orderLineSeedFields({ creatorAccountId: accountId, unitPriceAmount: 1000, quantity: 1 }),
    },
  });
  const tokenHash = randomUUID();
  const entitlement = await prisma.entitlement.create({
    data: {
      orderId: order.id,
      orderLineId: line.id,
      artworkId: artwork.id,
      accountId,
      serialNo: 1,
      // 1 明細 1 枚の下地なので 0 枚目。
      unitIndex: 0,
      claimTokenHash: tokenHash,
      status: 'issued',
    },
  });
  return { entitlementId: entitlement.id, accountId, tokenHash };
}

function enqueueInput(
  entitlementId: string,
  overrides: Partial<{ eventId: string; eventType: string; payload: string }> = {},
) {
  const payload = overrides.payload ?? JSON.stringify({ event_version: '1.0' });
  return {
    eventId: overrides.eventId ?? `evt_${randomUUID()}`,
    eventType: (overrides.eventType ?? 'entitlement.granted') as 'entitlement.granted',
    entitlementId,
    targetSiteKey: 'ovew-wallet',
    payload,
    payloadHash: hashOf(payload),
    correlationId: CORRELATION_ID,
    now: NOW,
  };
}

suite('受取確定と行列への追加（§11）', () => {
  it('同一トランザクションで両方が成立する', async () => {
    const { entitlementId, accountId } = await seedEntitlement();
    const payload = JSON.stringify({ event_version: '1.0', entitlement_id: entitlementId });

    const outcome = await claims.confirmClaim({
      entitlementId,
      commonUserId: PURCHASER_CU,
      accountId,
      now: NOW,
      delivery: {
        eventId: 'evt_same_tx',
        eventType: 'entitlement.granted',
        targetSiteKey: 'ovew-wallet',
        payload,
        payloadHash: hashOf(payload),
        correlationId: CORRELATION_ID,
      },
    });

    expect(outcome.kind).toBe('claimed');
    const row = await outbox.findByEventId('evt_same_tx');
    expect(row?.entitlementId).toBe(entitlementId);
    expect(row?.status).toBe('PENDING');
    const entitlement = await prisma.entitlement.findUniqueOrThrow({
      where: { id: entitlementId },
    });
    expect(entitlement.status).toBe('claimed');
    expect(entitlement.walletDeliveryStatus).toBe('pending');
  });

  it('行列への追加が失敗すれば、受取も成立しない', async () => {
    // ⚠️ これが分かれると「受け取ったのに Wallet へ永遠に届かない」行が、
    //    誰にも気づかれずに残る。
    const { entitlementId, accountId } = await seedEntitlement();

    await expect(
      claims.confirmClaim({
        entitlementId,
        commonUserId: PURCHASER_CU,
        accountId,
        now: NOW,
        delivery: {
          eventId: 'evt_bad',
          // CHECK 制約で弾かれる綴り。
          eventType: 'entitlement.unknown' as 'entitlement.granted',
          targetSiteKey: 'ovew-wallet',
          payload: '{}',
          payloadHash: hashOf('{}'),
          correlationId: CORRELATION_ID,
        },
      }),
    ).rejects.toThrow();

    const entitlement = await prisma.entitlement.findUniqueOrThrow({
      where: { id: entitlementId },
    });
    expect(entitlement.status).toBe('issued');
    expect(entitlement.walletDeliveryStatus).toBe('not_started');
  });

  it('競合して負けた側は行列に何も入れない', async () => {
    const { entitlementId, accountId } = await seedEntitlement();
    const payload = JSON.stringify({ event_version: '1.0' });
    const delivery = (eventId: string) => ({
      eventId,
      eventType: 'entitlement.granted' as const,
      targetSiteKey: 'ovew-wallet',
      payload,
      payloadHash: hashOf(payload),
      correlationId: CORRELATION_ID,
    });

    const [first, second] = await Promise.all([
      claims.confirmClaim({
        entitlementId,
        commonUserId: PURCHASER_CU,
        accountId,
        now: NOW,
        delivery: delivery('evt_race_1'),
      }),
      claims.confirmClaim({
        entitlementId,
        commonUserId: PURCHASER_CU,
        accountId,
        now: NOW,
        delivery: delivery('evt_race_2'),
      }),
    ]);

    const kinds = [first.kind, second.kind].sort();
    expect(kinds).toEqual(['claimed', 'raced']);
    // 受取が 1 回なら、行列の行も 1 件だけ。
    expect(await prisma.walletDeliveryOutbox.count()).toBe(1);
  });
});

suite('行列の制約', () => {
  it('同じ event_id は 2 度作れない（二重配送の最後の砦）', async () => {
    const { entitlementId } = await seedEntitlement();
    const input = enqueueInput(entitlementId, { eventId: 'evt_dup' });
    await outbox.enqueue(input);
    await expect(outbox.enqueue(input)).rejects.toThrow();
  });

  it('知らないイベント名は作れない', async () => {
    const { entitlementId } = await seedEntitlement();
    await expect(
      outbox.enqueue(enqueueInput(entitlementId, { eventType: 'entitlement.oops' })),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'wallet_delivery_outbox_event_type_known'),
    );
  });

  it('本文ハッシュの形式を強制する', async () => {
    const { entitlementId } = await seedEntitlement();
    await expect(
      prisma.walletDeliveryOutbox.create({
        data: {
          ...enqueueInput(entitlementId),
          payloadHash: 'not-a-hash',
          now: undefined,
        } as never,
      }),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'wallet_delivery_outbox_payload_hash_format'),
    );
  });

  it('相関IDに制御文字を含む値は入らない（ログ偽装を防ぐ）', async () => {
    const { entitlementId } = await seedEntitlement();
    await expect(
      outbox.enqueue({ ...enqueueInput(entitlementId), correlationId: 'bad\nvalue' }),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'wallet_delivery_outbox_correlation_id_format'),
    );
  });

  it('DELIVERED でないのに配送時刻が残る行は作れない', async () => {
    // ⚠️ 「作れないこと」だけでなく「**残らないこと**」まで見る。
    //    片方だけが入る書き方を許すと、いつ届いたのかを誰も答えられない。
    const { entitlementId } = await seedEntitlement();
    const row = await outbox.enqueue(enqueueInput(entitlementId));
    await expect(
      prisma.walletDeliveryOutbox.update({
        where: { id: row.id },
        data: { deliveredAt: NOW },
      }),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'wallet_delivery_outbox_delivered_at_matches_status'),
    );
  });

  it('DELIVERED から戻すときに配送時刻だけ残せない', async () => {
    const { entitlementId } = await seedEntitlement();
    const row = await outbox.enqueue(enqueueInput(entitlementId));
    await prisma.walletDeliveryOutbox.update({
      where: { id: row.id },
      data: { status: 'DELIVERED', deliveredAt: NOW },
    });
    await expect(
      prisma.walletDeliveryOutbox.update({
        where: { id: row.id },
        data: { status: 'FAILED' },
      }),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'wallet_delivery_outbox_delivered_at_matches_status'),
    );
  });
});

suite('ワーカーによる排他取得（§24）', () => {
  it('同時に走った 2 本が同じ行を掴まない', async () => {
    // ⚠️ 掴めてしまうと、同じイベントを二重に送る。
    //    相手の冪等性だけが最後の砦になり、こちらは気づけない。
    const { entitlementId } = await seedEntitlement();
    for (let index = 0; index < 4; index += 1) {
      await outbox.enqueue(enqueueInput(entitlementId, { eventId: `evt_${String(index)}` }));
    }

    const [left, right] = await Promise.all([
      outbox.claimBatch({ limit: 4, now: NOW }),
      outbox.claimBatch({ limit: 4, now: NOW }),
    ]);

    const ids = [...left, ...right].map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(4);
  });

  it('掴むと同時に試行回数が増える', async () => {
    const { entitlementId } = await seedEntitlement();
    await outbox.enqueue(enqueueInput(entitlementId));

    const [claimed] = await outbox.claimBatch({ limit: 1, now: NOW });
    expect(claimed?.attemptCount).toBe(1);
    expect(claimed?.status).toBe('PROCESSING');
  });

  it('再試行時刻が先の行は掴まない', async () => {
    const { entitlementId } = await seedEntitlement();
    const row = await outbox.enqueue(enqueueInput(entitlementId));
    await outbox.claimBatch({ limit: 1, now: NOW });
    await outbox.recordFailure({
      id: row.id,
      status: 'PENDING',
      nextRetryAt: new Date(NOW.getTime() + 60_000),
      errorCode: 'timeout',
      errorMessage: null,
      now: NOW,
    });

    expect(await outbox.claimBatch({ limit: 1, now: NOW })).toHaveLength(0);
    expect(
      await outbox.claimBatch({ limit: 1, now: new Date(NOW.getTime() + 60_000) }),
    ).toHaveLength(1);
  });

  it('PROCESSING のまま取り残された行を回収する', async () => {
    // ⚠️ 回収しないと、送信中に落ちた行は誰にも拾われず、
    //    エラーひとつ出さずに止まったまま残る。
    const { entitlementId } = await seedEntitlement();
    await outbox.enqueue(enqueueInput(entitlementId));
    await outbox.claimBatch({ limit: 1, now: NOW });

    const later = new Date(NOW.getTime() + 30 * 60_000);
    const reclaimed = await outbox.reclaimStale({
      staleBefore: new Date(later.getTime() - 15 * 60_000),
      now: later,
    });

    expect(reclaimed).toBe(1);
    const [again] = await outbox.claimBatch({ limit: 1, now: later });
    // 試行回数は戻さない。その 1 回は実際に送ろうとしたため。
    expect(again?.attemptCount).toBe(2);
  });
});

suite('配送の成否の記録（§19・§22）', () => {
  it('成功すると受取権も delivered になる', async () => {
    const { entitlementId, accountId } = await seedEntitlement();
    const payload = JSON.stringify({ event_version: '1.0' });
    await claims.confirmClaim({
      entitlementId,
      commonUserId: PURCHASER_CU,
      accountId,
      now: NOW,
      delivery: {
        eventId: 'evt_ok',
        eventType: 'entitlement.granted',
        targetSiteKey: 'ovew-wallet',
        payload,
        payloadHash: hashOf(payload),
        correlationId: CORRELATION_ID,
      },
    });
    const [claimed] = await outbox.claimBatch({ limit: 1, now: NOW });
    if (claimed === undefined) throw new Error('claim failed');

    expect(await outbox.markDelivered({ id: claimed.id, now: NOW })).toBe(true);

    const entitlement = await prisma.entitlement.findUniqueOrThrow({
      where: { id: entitlementId },
    });
    expect(entitlement.walletDeliveryStatus).toBe('delivered');
    expect(entitlement.walletDeliveredAt).toEqual(NOW);
  });

  it('DEAD になっても受取権は delivered にならない', async () => {
    const { entitlementId, accountId } = await seedEntitlement();
    const payload = JSON.stringify({ event_version: '1.0' });
    await claims.confirmClaim({
      entitlementId,
      commonUserId: PURCHASER_CU,
      accountId,
      now: NOW,
      delivery: {
        eventId: 'evt_dead',
        eventType: 'entitlement.granted',
        targetSiteKey: 'ovew-wallet',
        payload,
        payloadHash: hashOf(payload),
        correlationId: CORRELATION_ID,
      },
    });
    const [claimed] = await outbox.claimBatch({ limit: 1, now: NOW });
    if (claimed === undefined) throw new Error('claim failed');

    await outbox.recordFailure({
      id: claimed.id,
      status: 'DEAD',
      nextRetryAt: NOW,
      errorCode: 'timeout',
      errorMessage: null,
      now: NOW,
    });

    const entitlement = await prisma.entitlement.findUniqueOrThrow({
      where: { id: entitlementId },
    });
    expect(entitlement.walletDeliveryStatus).toBe('pending');
    expect(entitlement.walletDeliveredAt).toBeNull();
  });

  it('取り消しイベントの配送で受取権を delivered にしない', async () => {
    // 「取り消しを伝えられた」ことと「受け取れた」ことは別の事実。
    const { entitlementId } = await seedEntitlement();
    await outbox.enqueue(enqueueInput(entitlementId, { eventType: 'entitlement.revoked' }));
    const [claimed] = await outbox.claimBatch({ limit: 1, now: NOW });
    if (claimed === undefined) throw new Error('claim failed');

    expect(await outbox.markDelivered({ id: claimed.id, now: NOW })).toBe(true);

    const entitlement = await prisma.entitlement.findUniqueOrThrow({
      where: { id: entitlementId },
    });
    expect(entitlement.walletDeliveryStatus).toBe('not_started');
  });

  it('PROCESSING でない行は成功にできない', async () => {
    const { entitlementId } = await seedEntitlement();
    const row = await outbox.enqueue(enqueueInput(entitlementId));
    expect(await outbox.markDelivered({ id: row.id, now: NOW })).toBe(false);
  });
});

suite('手動再送（§20）', () => {
  it('DEAD を PENDING へ戻し、event_id と payload を変えない', async () => {
    const { entitlementId } = await seedEntitlement();
    const input = enqueueInput(entitlementId, { eventId: 'evt_manual' });
    const row = await outbox.enqueue(input);
    await outbox.claimBatch({ limit: 1, now: NOW });
    await outbox.recordFailure({
      id: row.id,
      status: 'DEAD',
      nextRetryAt: NOW,
      errorCode: 'timeout',
      errorMessage: null,
      now: NOW,
    });

    expect(await outbox.requeue({ id: row.id, now: NOW })).toBe(true);

    const after = await outbox.findByEventId('evt_manual');
    expect(after?.status).toBe('PENDING');
    expect(after?.payload).toBe(input.payload);
    expect(after?.attemptCount).toBe(0);
  });

  it('PROCESSING は戻さない（届いたか分からないため）', async () => {
    const { entitlementId } = await seedEntitlement();
    const row = await outbox.enqueue(enqueueInput(entitlementId));
    await outbox.claimBatch({ limit: 1, now: NOW });
    expect(await outbox.requeue({ id: row.id, now: NOW })).toBe(false);
  });
});

suite('注文の出自（§7）', () => {
  it('既定は PURCHASE', async () => {
    const { entitlementId } = await seedEntitlement();
    const entitlement = await prisma.entitlement.findUniqueOrThrow({
      where: { id: entitlementId },
      select: { order: { select: { source: true } } },
    });
    expect(entitlement.order.source).toBe('PURCHASE');
  });

  it('受取権は注文なしでは作れない（NOT NULL を緩めていない）', async () => {
    // ⚠️ Fixture のために列を緩めると、その穴は本番の経路にも開く。
    const { entitlementId } = await seedEntitlement();
    await expect(
      prisma.entitlement.update({
        where: { id: entitlementId },
        data: { orderId: null as never },
      }),
    ).rejects.toThrow();
  });
});

suite('作品の画像ハッシュ（§23）', () => {
  /** 作品には持ち主が要る。ここでは画像ハッシュだけが関心事なので、器を1つ用意する。 */
  async function creator(): Promise<string> {
    const id = randomUUID();
    await prisma.account.create({
      data: { id, authProvider: 'fake', authSubject: id },
    });
    return id;
  }

  it('形式の違う値は保存できない', async () => {
    const creatorAccountId = await creator();
    await expect(
      prisma.artwork.create({
        data: {
          creatorAccountId,
          slug: `artwork-${randomUUID()}`,
          title: 'x',
          maxSupply: 1,
          imageHash: 'sha256:zzz',
        },
      }),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'artworks_image_hash_format'),
    );
  });

  it('未設定（null）は許す', async () => {
    const creatorAccountId = await creator();
    const artwork = await prisma.artwork.create({
      data: { creatorAccountId, slug: `artwork-${randomUUID()}`, title: 'x', maxSupply: 1 },
    });
    expect(artwork.imageHash).toBeNull();
  });
});
