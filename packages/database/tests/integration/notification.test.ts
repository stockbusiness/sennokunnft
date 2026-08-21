import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  NOTIFICATION_EVENT_TYPES,
  validateTemplate,
  type NotificationEventType,
} from '@sengoku/domain';
import type { PrismaClient } from '../../generated/client';
import { PrismaNotificationOutboxRepository } from '../../src/repositories/notification.repository';
import { PrismaNotificationTemplateRepository } from '../../src/repositories/notification-template.repository';
import { PrismaNotificationHistoryRepository } from '../../src/repositories/notification-history.repository';
import { PrismaNotificationSweepRepository } from '../../src/repositories/notification-sweep.repository';
import {
  createTestClient,
  integrationTestsAvailable,
  orderLineSeedFields,
  orderSeedFields,
  resetDatabase,
  violatesConstraint,
} from '../helpers/database';

/**
 * 購入者への知らせ（P0-4）。
 *
 * ⚠️ ここで見たいのは、アプリの判定に穴が開いたときに**残る最後の砦**。
 *   1. 同じ種別・同じ対象の知らせは 1 通だけであること
 *   2. その重複で**業務のトランザクションが巻き戻らない**こと
 *   3. 宛先の平文を保存できないこと（`UD-503`）
 *   4. 既定の文面 9 件が、差し込み語彙の検査を通ること
 */
const enabled = integrationTestsAvailable();
const suite = enabled ? describe : describe.skip;

const NOW = new Date('2026-08-21T00:00:00.000Z');

let prisma: PrismaClient;
let outbox: PrismaNotificationOutboxRepository;
let templates: PrismaNotificationTemplateRepository;
let history: PrismaNotificationHistoryRepository;
let sweep: PrismaNotificationSweepRepository;

beforeAll(async () => {
  if (!enabled) return;
  prisma = createTestClient();
  await prisma.$connect();
  outbox = new PrismaNotificationOutboxRepository(prisma);
  templates = new PrismaNotificationTemplateRepository(prisma);
  history = new PrismaNotificationHistoryRepository(prisma);
  sweep = new PrismaNotificationSweepRepository(prisma);
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
  readonly orderId: string;
  readonly entitlementId: string;
}

/** 支払い済みの注文と受取権 1 枚。 */
async function seedPaidOrder(
  options: { readonly deliveryStatus?: 'not_started' | 'pending' | 'delivered' } = {},
): Promise<Seeded> {
  const accountId = randomUUID();
  await prisma.account.create({
    data: { id: accountId, authProvider: 'fake', authSubject: accountId },
  });
  const artwork = await prisma.artwork.create({
    data: {
      creatorAccountId: accountId,
      slug: `artwork-${randomUUID()}`,
      title: '知らせの試験の作品',
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
      ...orderSeedFields({ creatorAccountId: accountId, totalAmount: 3000 }),
    },
  });
  const line = await prisma.orderLine.create({
    data: {
      orderId: order.id,
      listingId: listing.id,
      artworkId: artwork.id,
      artworkTitleSnapshot: '知らせの試験の作品',
      unitPriceAmount: 3000,
      unitPriceCurrency: 'JPY',
      quantity: 1,
      ...orderLineSeedFields({ creatorAccountId: accountId, unitPriceAmount: 3000, quantity: 1 }),
    },
  });
  const delivered = options.deliveryStatus === 'delivered';
  const entitlement = await prisma.entitlement.create({
    data: {
      orderId: order.id,
      orderLineId: line.id,
      artworkId: artwork.id,
      accountId,
      serialNo: 1,
      unitIndex: 0,
      claimTokenHash: `hash-${randomUUID()}`,
      status: options.deliveryStatus === undefined ? 'issued' : 'claimed',
      ...(options.deliveryStatus === undefined
        ? {}
        : {
            claimedByAccountId: accountId,
            claimedAt: NOW,
            walletDeliveryStatus: options.deliveryStatus,
            ...(delivered ? { walletDeliveredAt: NOW } : {}),
          }),
    },
  });
  return { accountId, orderId: order.id, entitlementId: entitlement.id };
}

function enqueueInput(
  seeded: Seeded,
  overrides: Partial<{
    eventType: NotificationEventType;
    subjectId: string;
    renderedBody: string;
  }> = {},
): Parameters<PrismaNotificationOutboxRepository['enqueue']>[0] {
  return {
    id: randomUUID(),
    eventType: overrides.eventType ?? 'payment.succeeded',
    subjectType: 'order',
    subjectId: overrides.subjectId ?? seeded.orderId,
    accountId: seeded.accountId,
    renderedSubject: 'お支払いを確認しました',
    renderedBody: overrides.renderedBody ?? '本文',
    templateVersion: 1,
    correlationId: null,
    now: NOW,
  };
}

suite('購入者への知らせ（DB）', () => {
  it('積める', async () => {
    const seeded = await seedPaidOrder();
    const outcome = await outbox.enqueue(enqueueInput(seeded));
    expect(outcome.kind).toBe('created');
  });

  it('★ 同じ種別・同じ対象は 1 通だけ（重複した Webhook でも増えない）', async () => {
    const seeded = await seedPaidOrder();
    const first = await outbox.enqueue(enqueueInput(seeded));
    const second = await outbox.enqueue(enqueueInput(seeded));

    expect(first.kind).toBe('created');
    // ⚠️ 例外ではなく「冪等成功」。例外にすると業務側が巻き戻る。
    expect(second.kind).toBe('duplicate');
    expect(second.id).toBe(first.id);

    const count = await prisma.notificationDelivery.count({ where: { subjectId: seeded.orderId } });
    expect(count).toBe(1);
  });

  it('★ 重複しても、同じトランザクションの業務更新が巻き戻らない', async () => {
    const seeded = await seedPaidOrder();
    await outbox.enqueue(enqueueInput(seeded));

    // 業務の更新と一緒に、同じ知らせをもう一度積む。
    await prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: seeded.orderId },
        data: { refundStatus: 'refunded' },
      });
      await outbox.enqueue(enqueueInput(seeded), tx as never);
    });

    const order = await prisma.order.findUniqueOrThrow({ where: { id: seeded.orderId } });
    // ⚠️ ここが `none` に戻っていたら、UNIQUE 違反でトランザクションが
    //    巻き戻っている＝決済が通っているのに記録が消える形。
    expect(order.refundStatus).toBe('refunded');
    const count = await prisma.notificationDelivery.count({ where: { subjectId: seeded.orderId } });
    expect(count).toBe(1);
  });

  it('種別が違えば同じ注文でも別の知らせになる', async () => {
    const seeded = await seedPaidOrder();
    await outbox.enqueue(enqueueInput(seeded, { eventType: 'payment.succeeded' }));
    await outbox.enqueue(enqueueInput(seeded, { eventType: 'payment.failed' }));
    const count = await prisma.notificationDelivery.count({ where: { subjectId: seeded.orderId } });
    expect(count).toBe(2);
  });

  it('★ 宛先に伏せ字の無い値を保存できない（UD-503）', async () => {
    const seeded = await seedPaidOrder();
    const outcome = await outbox.enqueue(enqueueInput(seeded));
    await expect(
      prisma.notificationDelivery.update({
        where: { id: outcome.id },
        // 平文のアドレスをそのまま入れようとする。
        data: { maskedRecipient: 'tanaka@example.jp' },
      }),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'notification_deliveries_recipient_is_masked'),
    );
  });

  it('★ 「送った」と「送った時刻」を分離できない', async () => {
    const seeded = await seedPaidOrder();
    const outcome = await outbox.enqueue(enqueueInput(seeded));
    await expect(
      prisma.notificationDelivery.update({
        where: { id: outcome.id },
        data: { status: 'SENT' },
      }),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'notification_deliveries_sent_at_matches_status'),
    );
  });

  it('★ 理由の無い SKIPPED を作れない', async () => {
    const seeded = await seedPaidOrder();
    const outcome = await outbox.enqueue(enqueueInput(seeded));
    await expect(
      prisma.notificationDelivery.update({
        where: { id: outcome.id },
        data: { status: 'SKIPPED' },
      }),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'notification_deliveries_skipped_has_reason'),
    );
  });

  it('掴んだ行は試行回数が増え、二度は掴めない', async () => {
    const seeded = await seedPaidOrder();
    await outbox.enqueue(enqueueInput(seeded));
    const first = await outbox.claimBatch({ limit: 10, now: NOW });
    const second = await outbox.claimBatch({ limit: 10, now: NOW });
    expect(first).toHaveLength(1);
    expect(first[0]!.attemptCount).toBe(1);
    expect(second).toHaveLength(0);
  });

  it('送信できたら伏せた宛先と照合値が残る', async () => {
    const seeded = await seedPaidOrder();
    await outbox.enqueue(enqueueInput(seeded));
    const [claimed] = await outbox.claimBatch({ limit: 1, now: NOW });
    const marked = await outbox.markSent({
      id: claimed!.id,
      providerMessageId: 'msg-1',
      maskedRecipient: 't*****@e******.jp',
      recipientHash: 'hash',
      now: NOW,
    });
    expect(marked).toBe(true);

    const row = await history.findById(claimed!.id);
    expect(row?.status).toBe('SENT');
    expect(row?.maskedRecipient).toBe('t*****@e******.jp');
  });

  it('★ 送信履歴は本文を持ち出さない', async () => {
    const seeded = await seedPaidOrder();
    await outbox.enqueue(enqueueInput(seeded, { renderedBody: '秘密の本文' }));
    const page = await history.list({ limit: 10 });
    expect(page.items).toHaveLength(1);
    // 型に項目が無いので、そもそも載せようがない。値としても出ない。
    expect(JSON.stringify(page.items)).not.toContain('秘密の本文');
  });

  it('⚠️ 送り直せるのは失敗した知らせだけ', async () => {
    const seeded = await seedPaidOrder();
    await outbox.enqueue(enqueueInput(seeded));
    const [claimed] = await outbox.claimBatch({ limit: 1, now: NOW });
    // 送信中のものは戻せない。
    expect(await outbox.requeue({ id: claimed!.id, now: NOW })).toBe(false);

    await outbox.recordFailure({
      id: claimed!.id,
      status: 'FAILED',
      nextRetryAt: NOW,
      errorCode: 'http_422',
      errorMessage: null,
      now: NOW,
    });
    expect(await outbox.requeue({ id: claimed!.id, now: NOW })).toBe(true);
  });
});

suite('既定の文面（DB）', () => {
  it('★ 9 種別すべてが公開済みで入っている', async () => {
    for (const eventType of NOTIFICATION_EVENT_TYPES) {
      const found = await templates.findPublished(eventType);
      expect(found, eventType).not.toBeNull();
      expect(found?.version).toBe(1);
    }
  });

  it('★ 既定の文面が差し込み語彙の検査を通る', async () => {
    // ⚠️ ここが落ちるときは、文面か語彙のどちらかが先に変わっている。
    //    送る段になって「差し込む値が足りない」で全件止まる前に気づく。
    for (const eventType of NOTIFICATION_EVENT_TYPES) {
      const found = await templates.findPublished(eventType);
      const result = validateTemplate({
        eventType,
        subject: found!.subject,
        body: found!.body,
      });
      expect(result.ok, `${eventType}: ${result.ok ? '' : result.error.code}`).toBe(true);
    }
  });

  it('新しい版を作っても、前の版は書き換わらない', async () => {
    const before = await templates.findPublished('order.placed');
    await templates.createVersion({
      eventType: 'order.placed',
      subject: '新しい件名 {{orderNumber}}',
      body: '新しい本文 {{orderNumber}}',
      status: 'draft',
      actorAccountId: null,
      now: NOW,
    });
    const versions = await templates.listVersions('order.placed');
    expect(versions).toHaveLength(2);
    // 公開済みは 1 版のまま（下書きは有効にならない）。
    const current = await templates.findPublished('order.placed');
    expect(current?.subject).toBe(before?.subject);
  });

  it('下書きを公開すると、そちらが有効になる', async () => {
    const created = await templates.createVersion({
      eventType: 'order.placed',
      subject: '第 2 版 {{orderNumber}}',
      body: '本文 {{orderNumber}}',
      status: 'draft',
      actorAccountId: null,
      now: NOW,
    });
    expect(
      await templates.publish({
        eventType: 'order.placed',
        version: created.version,
        actorAccountId: null,
        now: NOW,
      }),
    ).toBe(true);
    const current = await templates.findPublished('order.placed');
    expect(current?.version).toBe(created.version);
    // ⚠️ 二度目は何もしない。
    expect(
      await templates.publish({
        eventType: 'order.placed',
        version: created.version,
        actorAccountId: null,
        now: NOW,
      }),
    ).toBe(false);
  });
});

suite('お届け結果の数え上げ（DB）', () => {
  it('届いた受取権を拾う', async () => {
    const seeded = await seedPaidOrder({ deliveryStatus: 'delivered' });
    const rows = await sweep.listDeliveredWithoutNotice(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entitlementId).toBe(seeded.entitlementId);
    expect(rows[0]!.artworkTitle).toBe('知らせの試験の作品');
  });

  it('★ すでに積んである分は拾わない（何度走らせても増えない）', async () => {
    const seeded = await seedPaidOrder({ deliveryStatus: 'delivered' });
    await outbox.enqueue({
      id: randomUUID(),
      eventType: 'entitlement.delivered',
      subjectType: 'entitlement',
      subjectId: seeded.entitlementId,
      accountId: seeded.accountId,
      renderedSubject: '件名',
      renderedBody: '本文',
      templateVersion: 1,
      correlationId: null,
      now: NOW,
    });
    expect(await sweep.listDeliveredWithoutNotice(10)).toHaveLength(0);
  });

  it('⚠️ まだ届いていない受取権は拾わない', async () => {
    await seedPaidOrder({ deliveryStatus: 'pending' });
    expect(await sweep.listDeliveredWithoutNotice(10)).toHaveLength(0);
  });
});
