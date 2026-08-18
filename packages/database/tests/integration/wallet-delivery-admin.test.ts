import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '../../generated/client';
import { PrismaAuditLogReadRepository } from '../../src/repositories/audit.repository';
import { PrismaWalletDeliveryAdminRepository } from '../../src/repositories/wallet-delivery-admin.repository';
import {
  TEST_DATABASE_URL,
  createTestClient,
  integrationTestsAvailable,
  resetDatabase,
} from '../helpers/database';

/**
 * 送信の運用画面と監査ログの読み出しを、実 PostgreSQL に対して確かめる。
 *
 * ⚠️ **Fake で済ませない。** 確かめたいのは次の 3 つで、
 * どれも DB の挙動そのものに依っている。
 *  - `payload` が **SELECT されない**こと（列を選ばない実装かどうか）
 *  - 続きの位置（カーソル）で**行が飛ばされない・重複しない**こと
 *  - `GROUP BY` が返さない「0 件の状態」も件数に現れること
 */
const enabled = integrationTestsAvailable();
const suite = enabled ? describe : describe.skip;

let prisma: PrismaClient;
let deliveries: PrismaWalletDeliveryAdminRepository;
let auditLogs: PrismaAuditLogReadRepository;

const NOW = new Date('2026-08-18T00:00:00.000Z');

beforeAll(async () => {
  if (!enabled) return;
  prisma = createTestClient();
  await prisma.$connect();
  deliveries = new PrismaWalletDeliveryAdminRepository(prisma);
  auditLogs = new PrismaAuditLogReadRepository(prisma);
});

afterAll(async () => {
  if (!enabled) return;
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!enabled) return;
  await resetDatabase(prisma);
});

/** 配送行を作るのに要る最小限の下地。 */
async function seedEntitlement(): Promise<string> {
  const accountId = randomUUID();
  await prisma.account.create({
    data: { id: accountId, authProvider: 'fake', authSubject: accountId },
  });
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
    },
  });
  const entitlement = await prisma.entitlement.create({
    data: {
      orderId: order.id,
      orderLineId: line.id,
      artworkId: artwork.id,
      accountId,
      serialNo: 1,
      claimTokenHash: randomUUID(),
      status: 'issued',
    },
  });
  return entitlement.id;
}

const SECRET_PAYLOAD = JSON.stringify({
  event_version: '1.0',
  common_user_id: 'cu_0123456789abcdef0123456789abcdef',
});

async function seedDelivery(
  entitlementId: string,
  overrides: {
    status?: 'PENDING' | 'PROCESSING' | 'DELIVERED' | 'FAILED' | 'DEAD';
    createdAt?: Date;
    eventId?: string;
  } = {},
): Promise<string> {
  const row = await prisma.walletDeliveryOutbox.create({
    data: {
      eventId: overrides.eventId ?? `evt_${randomUUID()}`,
      eventType: 'entitlement.granted',
      entitlementId,
      targetSiteKey: 'ovew-wallet',
      payload: SECRET_PAYLOAD,
      payloadHash: `sha256:${createHash('sha256').update(SECRET_PAYLOAD, 'utf8').digest('hex')}`,
      correlationId: 'corr_0123456789',
      status: overrides.status ?? 'PENDING',
      // `wallet_delivery_outbox_delivered_at_matches_status`：
      // 届いた時刻と状態は必ず揃う。片方だけ入れた行は DB が作らせない。
      deliveredAt: overrides.status === 'DELIVERED' ? NOW : null,
      nextRetryAt: NOW,
      createdAt: overrides.createdAt ?? NOW,
      updatedAt: overrides.createdAt ?? NOW,
    },
  });
  return row.id;
}

const ALL: {
  statuses: readonly [];
  eventId: null;
  entitlementId: null;
  cursor: null;
  limit: number;
} = { statuses: [], eventId: null, entitlementId: null, cursor: null, limit: 20 };

suite('配送一覧（指示書 §5）', () => {
  /*
    ⚠️ **この試験が本丸。** 「画面に出さない」ではなく
       「そもそも取ってこない」ことを確かめる。JSON へ直して
       本文が 1 文字も混ざらないことまで見る。
  */
  it('本文（payload）を一切返さない', async () => {
    const entitlementId = await seedEntitlement();
    await seedDelivery(entitlementId);

    const page = await deliveries.list(ALL);

    expect(page.items).toHaveLength(1);
    const [item] = page.items;
    expect(item).toBeDefined();
    expect(Object.keys(item as object)).not.toContain('payload');
    // 本文の断片が、どの項目にも紛れ込んでいないこと。
    expect(JSON.stringify(page)).not.toContain('common_user_id');
    expect(JSON.stringify(page)).not.toContain('event_version');
    // 突き合わせ用のハッシュは返る。中身は分からないが、変化は分かる。
    expect(item?.payloadHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  /*
    ⚠️ **「返さない」だけでなく「取ってこない」ことを確かめる。**
       写す側で落とす実装でも上の試験は通ってしまう。だが取ってきた時点で
       その値はこのプロセスに乗り、例外やログの出力対象になる。
       発行された SQL に本文の列が現れないことまで見る。
       （`payload_hash` は現れてよいので、閉じ引用符まで含めて照合する）
  */
  it('本文の列を SELECT していない', async () => {
    const entitlementId = await seedEntitlement();
    await seedDelivery(entitlementId);

    const spy = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL as string } },
      log: [{ emit: 'event', level: 'query' }],
    });
    const statements: string[] = [];
    spy.$on('query', (event) => {
      statements.push(event.query);
    });

    try {
      await new PrismaWalletDeliveryAdminRepository(spy).list(ALL);
    } finally {
      await spy.$disconnect();
    }

    expect(statements.length).toBeGreaterThan(0);
    expect(statements.join('\n')).not.toContain('"payload"');
    // 取り違えていないことの裏取り。ハッシュの列はちゃんと読んでいる。
    expect(statements.join('\n')).toContain('"payload_hash"');
  });

  it('1 件取得でも本文を返さない', async () => {
    const entitlementId = await seedEntitlement();
    const id = await seedDelivery(entitlementId);

    const found = await deliveries.findById(id);

    expect(found?.id).toBe(id);
    expect(Object.keys(found as object)).not.toContain('payload');
    expect(JSON.stringify(found)).not.toContain('common_user_id');
  });

  it('無い行は null', async () => {
    expect(await deliveries.findById(randomUUID())).toBeNull();
  });

  it('状態で絞り込める', async () => {
    const entitlementId = await seedEntitlement();
    await seedDelivery(entitlementId, { status: 'DELIVERED' });
    await seedDelivery(entitlementId, { status: 'DEAD' });
    await seedDelivery(entitlementId, { status: 'FAILED' });

    const page = await deliveries.list({ ...ALL, statuses: ['FAILED', 'DEAD'] });

    expect(page.items.map((item) => item.status).sort()).toEqual(['DEAD', 'FAILED']);
  });

  it('イベントIDで 1 件を引ける', async () => {
    const entitlementId = await seedEntitlement();
    await seedDelivery(entitlementId, { eventId: 'evt_wanted' });
    await seedDelivery(entitlementId, { eventId: 'evt_other' });

    const page = await deliveries.list({ ...ALL, eventId: 'evt_wanted' });

    expect(page.items.map((item) => item.eventId)).toEqual(['evt_wanted']);
  });

  /*
    ⚠️ **同じ時刻の行をわざと作る。** 時刻だけでカーソルを作ると、
       同時刻の行が並んだところで残りが飛ばされる。実際に起きうるのは、
       1 回の受取確定で複数の配送行が同じミリ秒に作られる場面。
  */
  it('作成時刻が同じ行が並んでも、続きで飛ばさない・重複しない', async () => {
    const entitlementId = await seedEntitlement();
    const created = new Date('2026-08-18T01:00:00.000Z');
    for (let i = 0; i < 5; i += 1) {
      await seedDelivery(entitlementId, { createdAt: created, eventId: `evt_${i}` });
    }

    const first = await deliveries.list({ ...ALL, limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await deliveries.list({ ...ALL, limit: 2, cursor: first.nextCursor });
    const third = await deliveries.list({ ...ALL, limit: 2, cursor: second.nextCursor });

    const seen = [...first.items, ...second.items, ...third.items].map((item) => item.eventId);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(third.nextCursor).toBeNull();
  });

  it('新しい順に並ぶ', async () => {
    const entitlementId = await seedEntitlement();
    await seedDelivery(entitlementId, {
      eventId: 'evt_old',
      createdAt: new Date('2026-08-17T00:00:00.000Z'),
    });
    await seedDelivery(entitlementId, {
      eventId: 'evt_new',
      createdAt: new Date('2026-08-18T00:00:00.000Z'),
    });

    const page = await deliveries.list(ALL);

    expect(page.items.map((item) => item.eventId)).toEqual(['evt_new', 'evt_old']);
  });

  /*
    ⚠️ 0 件の状態が欄ごと消えないこと。「失敗の欄が無い」と
       「失敗が 0 件」は、見た人にとってまったく違う意味になる。
  */
  it('件数は、1 件も無い状態も 0 として返す', async () => {
    const entitlementId = await seedEntitlement();
    await seedDelivery(entitlementId, { status: 'DEAD' });
    await seedDelivery(entitlementId, { status: 'DEAD' });

    const counts = await deliveries.countByStatus();

    expect(counts).toEqual({
      PENDING: 0,
      PROCESSING: 0,
      DELIVERED: 0,
      FAILED: 0,
      DEAD: 2,
    });
  });
});

suite('監査ログの閲覧（指示書 §5）', () => {
  async function seedAccount(email: string | null): Promise<string> {
    const id = randomUUID();
    await prisma.account.create({
      // 連絡先を持てるのはスタッフだけ（`accounts_staff_email_only_for_staff`）。
      data: { id, authProvider: 'fake', authSubject: id, role: 'operator', staffEmail: email },
    });
    return id;
  }

  const BASE = {
    actionPrefix: null,
    targetType: null,
    targetId: null,
    actorAccountId: null,
    cursor: null,
    limit: 30,
    includeActorContact: false,
  } as const;

  it('連絡先を求めなければ、連絡先を返さない', async () => {
    const actorId = await seedAccount('ops@example.com');
    await prisma.auditLog.create({
      data: {
        actorAccountId: actorId,
        action: 'staff.invite',
        targetType: 'staff_invitation',
        summary: { role: 'operator' },
      },
    });

    const page = await auditLogs.list(BASE);

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.actorEmail).toBeNull();
    expect(JSON.stringify(page)).not.toContain('ops@example.com');
  });

  it('連絡先を求めれば返る', async () => {
    const actorId = await seedAccount('ops@example.com');
    await prisma.auditLog.create({
      data: {
        actorAccountId: actorId,
        action: 'staff.invite',
        targetType: 'staff_invitation',
        summary: { role: 'operator' },
      },
    });

    const page = await auditLogs.list({ ...BASE, includeActorContact: true });

    expect(page.items[0]?.actorEmail).toBe('ops@example.com');
  });

  it('システムによる操作（操作者なし）でも読める', async () => {
    await prisma.auditLog.create({
      data: { action: 'listing.end', targetType: 'listing', summary: {} },
    });

    const page = await auditLogs.list({ ...BASE, includeActorContact: true });

    expect(page.items[0]?.actorAccountId).toBeNull();
    expect(page.items[0]?.actorEmail).toBeNull();
  });

  it('操作名の前方一致で絞り込める', async () => {
    await prisma.auditLog.create({
      data: { action: 'staff.invite', targetType: 'staff_invitation', summary: {} },
    });
    await prisma.auditLog.create({
      data: { action: 'staff.update', targetType: 'account', summary: {} },
    });
    await prisma.auditLog.create({
      data: { action: 'artwork.publish', targetType: 'artwork', summary: {} },
    });

    const page = await auditLogs.list({ ...BASE, actionPrefix: 'staff.' });

    expect(page.items.map((item) => item.action).sort()).toEqual(['staff.invite', 'staff.update']);
  });

  it('同時刻の行が並んでも、続きで飛ばさない・重複しない', async () => {
    const occurredAt = new Date('2026-08-18T02:00:00.000Z');
    for (let i = 0; i < 5; i += 1) {
      await prisma.auditLog.create({
        data: {
          action: `artwork.update`,
          targetType: 'artwork',
          summary: { index: i },
          occurredAt,
        },
      });
    }

    const first = await auditLogs.list({ ...BASE, limit: 2 });
    const second = await auditLogs.list({ ...BASE, limit: 2, cursor: first.nextCursor });
    const third = await auditLogs.list({ ...BASE, limit: 2, cursor: second.nextCursor });

    const ids = [...first.items, ...second.items, ...third.items].map((item) => item.id);
    expect(new Set(ids).size).toBe(5);
    expect(third.nextCursor).toBeNull();
  });
});
