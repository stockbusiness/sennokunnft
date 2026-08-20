import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaOrderNoteRepository } from '../../src/repositories/order.repository';
import type { PrismaClient } from '../../generated/client';
import { createTestClient, integrationTestsAvailable } from '../helpers/database';

/**
 * 注文の検索と問い合わせ対応（`UD-121`）の DB 側。
 *
 * ⚠️ **Fake では確かめられないものだけを見る。** CHECK 制約と、
 * 「削除の口が無い」ことの担保（外部キーの `ON DELETE RESTRICT`）。
 */

const available = integrationTestsAvailable();
const describeIf = available ? describe : describe.skip;

let prisma: PrismaClient;
let notes: PrismaOrderNoteRepository;

const NOW = new Date('2026-08-20T00:00:00.000Z');

/** 注文を 1 件そろえる。制約を見るのに必要な最小限だけ作る。 */
async function seedOrder(): Promise<{ orderId: string; accountId: string }> {
  const accountId = randomUUID();
  const creatorId = randomUUID();
  const artworkId = randomUUID();
  const orderId = randomUUID();

  for (const [id, subject] of [
    [accountId, `buyer-${accountId}`],
    [creatorId, `creator-${creatorId}`],
  ] as const) {
    await prisma.account.create({
      data: { id, authProvider: 'test', authSubject: subject, role: 'buyer', status: 'active' },
    });
  }
  await prisma.artwork.create({
    data: {
      id: artworkId,
      slug: `slug-${artworkId}`,
      title: '春の宵',
      status: 'published',
      maxSupply: 10,
      creatorAccountId: creatorId,
    },
  });
  await prisma.order.create({
    data: {
      id: orderId,
      orderNumber: `SNK-20260820-${randomUUID().slice(0, 8).toUpperCase()}`,
      accountId,
      creatorAccountId: creatorId,
      status: 'pending',
      subtotalAmount: 12000,
      totalAmount: 12000,
      totalCurrency: 'JPY',
      platformFeeRateBps: 2000,
      platformFeeAmount: 2400,
      creatorAmount: 9600,
      idempotencyKey: randomUUID(),
    },
  });
  return { orderId, accountId };
}

beforeAll(() => {
  if (!available) return;
  prisma = createTestClient();
  notes = new PrismaOrderNoteRepository(prisma);
});

afterAll(async () => {
  if (!available) return;
  await prisma.$disconnect();
});

describeIf('order_notes の制約（UD-121）', () => {
  it('メモを足せて、古い順に読める', async () => {
    const { orderId, accountId } = await seedOrder();

    await notes.append({
      id: randomUUID(),
      orderId,
      authorAccountId: accountId,
      body: '2 件目',
      now: new Date(NOW.getTime() + 1000),
    });
    await notes.append({
      id: randomUUID(),
      orderId,
      authorAccountId: accountId,
      body: '1 件目',
      now: NOW,
    });

    const listed = await notes.listByOrder(orderId);
    // ⚠️ 古い順。経過へそのまま差し込むため。
    expect(listed.map((note) => note.body)).toEqual(['1 件目', '2 件目']);
  });

  it('空白だけの本文は DB が拒む（アプリの検査が抜けても止まる）', async () => {
    const { orderId, accountId } = await seedOrder();
    await expect(
      prisma.orderNote.create({
        data: { id: randomUUID(), orderId, authorAccountId: accountId, body: '   ' },
      }),
    ).rejects.toThrow(/order_notes_body_not_blank/u);
  });

  it('上限を超える本文は DB が拒む', async () => {
    const { orderId, accountId } = await seedOrder();
    await expect(
      prisma.orderNote.create({
        data: {
          id: randomUUID(),
          orderId,
          authorAccountId: accountId,
          body: 'あ'.repeat(2001),
        },
      }),
    ).rejects.toThrow(/order_notes_body_length/u);
  });

  /**
   * ⚠️ **書いた人の行を消して記録を消せないこと。** 退職者のアカウントを
   * 消したら対応の記録も消えた、では揉めたときに何も参照できない。
   */
  it('メモが残っている限り、書いた人のアカウントを消せない', async () => {
    const { orderId, accountId } = await seedOrder();
    await notes.append({
      id: randomUUID(),
      orderId,
      authorAccountId: accountId,
      body: '受付しました。',
      now: NOW,
    });

    await expect(prisma.account.delete({ where: { id: accountId } })).rejects.toThrow();
  });

  it('メモが残っている限り、注文を消せない', async () => {
    const { orderId, accountId } = await seedOrder();
    await notes.append({
      id: randomUUID(),
      orderId,
      authorAccountId: accountId,
      body: '受付しました。',
      now: NOW,
    });

    await expect(prisma.order.delete({ where: { id: orderId } })).rejects.toThrow();
  });
});
