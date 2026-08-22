import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../../generated/client';
import {
  PrismaCreatorInquiryRepository,
  PrismaCreatorReceivableRepository,
  PrismaRefundRequestRepository,
} from '../../src/repositories/refund-request.repository';
import {
  createTestClient,
  integrationTestsAvailable,
  resetDatabase,
  violatesConstraint,
  violatesUniqueConstraint,
} from '../helpers/database';

/**
 * 返金の申請と審査（方針整理 2026-08-22）。
 *
 * ⚠️ **ここで見たいのは 6 つ。**
 *  1. **同じ注文に、決着していない申請を 2 つ作れないこと**（二重返金の入口）
 *  2. **二重承認が「別の人」でなければ成立しないこと**（DB でも止める）
 *  3. 却下に理由が要ること／実行済みに返金の行が要ること
 *  4. **証跡を書き換えられない・消せないこと**
 *  5. **同じ注文で回収待ちを 2 行作れないこと**（二重の取り立て）
 *  6. 状態を進めるのが**条件付き更新**であること（同時に 2 人が承認できない）
 */
const enabled = integrationTestsAvailable();
const suite = enabled ? describe : describe.skip;

const NOW = new Date('2026-08-22T00:00:00.000Z');

let prisma: PrismaClient;
let requests: PrismaRefundRequestRepository;
let inquiries: PrismaCreatorInquiryRepository;
let receivables: PrismaCreatorReceivableRepository;

let buyerId: string;
let creatorId: string;
let orderId: string;

beforeAll(() => {
  if (!enabled) return;
  prisma = createTestClient();
  requests = new PrismaRefundRequestRepository(prisma);
  inquiries = new PrismaCreatorInquiryRepository(prisma);
  receivables = new PrismaCreatorReceivableRepository(prisma);
});

afterAll(async () => {
  if (enabled) await prisma.$disconnect();
});

beforeEach(async () => {
  if (!enabled) return;
  await resetDatabase(prisma);
  buyerId = randomUUID();
  creatorId = randomUUID();
  for (const [id, subject] of [
    [buyerId, `buyer-${buyerId}`],
    [creatorId, `creator-${creatorId}`],
  ] as const) {
    await prisma.account.create({
      data: { id, authProvider: 'test', authSubject: subject },
    });
  }
  await prisma.artwork.create({
    data: {
      id: randomUUID(),
      slug: `slug-${randomUUID()}`,
      title: '天下布武の陣羽織',
      status: 'published',
      maxSupply: 10,
      creatorAccountId: creatorId,
    },
  });
  const order = await prisma.order.create({
    data: {
      orderNumber: `SNK-${randomUUID().slice(0, 8).toUpperCase()}`,
      accountId: buyerId,
      creatorAccountId: creatorId,
      status: 'paid',
      subtotalAmount: 12000,
      totalAmount: 12000,
      totalCurrency: 'JPY',
      platformFeeRateBps: 2000,
      platformFeeAmount: 2400,
      creatorAmount: 9600,
      paymentStatus: 'succeeded',
      paidAt: NOW,
      idempotencyKey: randomUUID(),
    },
  });
  orderId = order.id;
});

function newRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    orderId,
    reason: 'not_as_described' as const,
    category: 'creator_confirmation' as const,
    amount: 12000,
    isFullRefund: true,
    entitlementDisposition: 'revoke' as const,
    requestedByAccountId: buyerId,
    buyerStatement: '説明と違いました',
    status: 'submitted' as const,
    now: NOW,
    ...overrides,
  };
}

suite('申請', () => {
  it('作って読み戻せる', async () => {
    const created = await requests.create(newRequest());
    expect(await requests.find(created.id)).toMatchObject({
      status: 'submitted',
      category: 'creator_confirmation',
      amount: 12000,
      isFullRefund: true,
    });
  });

  /*
    ⚠️ **同じ注文に、決着していない申請を 2 つ作らない。** 作れると、
       2 人が別々に承認して**二重返金**になる。
  */
  it('同じ注文に、決着していない申請を 2 つ作れない', async () => {
    await requests.create(newRequest());
    await expect(requests.create(newRequest())).rejects.toSatisfy(violatesUniqueConstraint);
  });

  /*
    ⚠️ **決着したあとなら、もう一度申請できる。** 一部返金のあとに残りを
       返す、という場面がある。
  */
  it('決着したあとなら、もう一度申請できる', async () => {
    const first = await requests.create(newRequest());
    await requests.transition({
      id: first.id,
      from: ['submitted'],
      to: 'rejected',
      patch: { rejectionNote: '対象外のため' },
      now: NOW,
    });

    const second = await requests.create(newRequest());
    expect(second.id).not.toBe(first.id);
    expect(await requests.findOpenByOrder(orderId)).toMatchObject({ id: second.id });
  });

  /*
    ⚠️ **状態を進めるのは条件付き更新。** 2 人が同時に承認したときに
       両方通ると、二重返金の入口になる。
  */
  it('同じ遷移は 1 回しか通らない', async () => {
    const created = await requests.create(newRequest());
    const first = await requests.transition({
      id: created.id,
      from: ['submitted'],
      to: 'reviewed',
      now: NOW,
    });
    const second = await requests.transition({
      id: created.id,
      from: ['submitted'],
      to: 'reviewed',
      now: NOW,
    });
    expect(first).toBe(true);
    // ⚠️ 2 回目は「すでに誰かが進めた」。
    expect(second).toBe(false);
  });
});

suite('DB が止めること', () => {
  /*
    ⚠️ **二重承認は「別の人」でなければ成立しない。** アプリ側でも見るが、
       DB でも止める——アプリを通さない書き込みがありうる。
  */
  it('同じ人が申請して承認した行を拒む', async () => {
    const created = await requests.create(newRequest({ requestedByAccountId: creatorId }));
    await expect(
      requests.transition({
        id: created.id,
        from: ['submitted'],
        to: 'approved',
        patch: { dualApprovalRequired: true, approvedByAccountId: creatorId },
        now: NOW,
      }),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'refund_requests_dual_approval_distinct'),
    );
  });

  it('別の人なら通る', async () => {
    const created = await requests.create(newRequest({ requestedByAccountId: creatorId }));
    await expect(
      requests.transition({
        id: created.id,
        from: ['submitted'],
        to: 'approved',
        patch: { dualApprovalRequired: true, approvedByAccountId: buyerId },
        now: NOW,
      }),
    ).resolves.toBe(true);
  });

  /** ⚠️ 理由の無い却下は、購入者にも運営自身にも説明できない。 */
  it('理由の無い却下を拒む', async () => {
    const created = await requests.create(newRequest());
    await expect(
      requests.transition({ id: created.id, from: ['submitted'], to: 'rejected', now: NOW }),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'refund_requests_rejection_has_note'),
    );
  });

  /*
    ⚠️ **返金の行が無いまま `executed` にしない。** 「返金した」という記録
       だけがあって、返金そのものが無い状態になる。
  */
  it('返金の行が無い実行済みを拒む', async () => {
    const created = await requests.create(newRequest());
    await expect(
      requests.transition({ id: created.id, from: ['submitted'], to: 'executed', now: NOW }),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'refund_requests_executed_has_refund'),
    );
  });

  it('知らない状態を拒む', async () => {
    await expect(requests.create(newRequest({ status: 'とりあえず保留' }))).rejects.toSatisfy(
      (error: unknown) => violatesConstraint(error, 'refund_requests_status_known'),
    );
  });

  it('0 円の申請を拒む', async () => {
    await expect(requests.create(newRequest({ amount: 0 }))).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'refund_requests_amount_positive'),
    );
  });
});

suite('証跡', () => {
  /*
    ⚠️ **書き換えられる証跡は、証跡ではない。** アプリに口を作らないだけ
       では足りない——アプリを通さない書き込みも止める。
  */
  it('書き換えられない・消せない', async () => {
    const created = await requests.create(newRequest());
    await requests.appendEvent({
      id: randomUUID(),
      requestId: created.id,
      action: 'submitted',
      actorAccountId: buyerId,
      summary: { amount: 12000 },
      now: NOW,
    });

    await expect(
      prisma.refundRequestEvent.updateMany({ where: {}, data: { action: 'なかったことに' } }),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'refund_request_events_append_only'),
    );
    await expect(prisma.refundRequestEvent.deleteMany({ where: {} })).rejects.toSatisfy(
      (error: unknown) => violatesConstraint(error, 'refund_request_events_append_only'),
    );
    // ⚠️ 空振りでないことを確かめる（行はある）。
    expect(await prisma.refundRequestEvent.count()).toBe(1);
  });
});

suite('作家さまへの確認', () => {
  it('依頼して、答えられる', async () => {
    const created = await requests.create(newRequest());
    await inquiries.ask({
      id: randomUUID(),
      requestId: created.id,
      creatorAccountId: creatorId,
      dueAt: new Date('2026-08-27T00:00:00.000Z'),
      now: NOW,
    });

    const answered = await inquiries.answer({
      requestId: created.id,
      creatorAccountId: creatorId,
      answer: '説明のとおりお渡ししています',
      attachmentKeys: ['key-1'],
      now: NOW,
    });
    expect(answered).toBe(true);
    expect(await inquiries.findByRequest(created.id)).toMatchObject({
      answer: '説明のとおりお渡ししています',
      attachmentKeys: ['key-1'],
    });
  });

  /*
    ⚠️ **二度目の回答で最初の回答を上書きしない。** 何を根拠に判断したかが
       失われる。
  */
  it('二度目の回答は受け付けない', async () => {
    const created = await requests.create(newRequest());
    await inquiries.ask({
      id: randomUUID(),
      requestId: created.id,
      creatorAccountId: creatorId,
      dueAt: new Date('2026-08-27T00:00:00.000Z'),
      now: NOW,
    });
    await inquiries.answer({
      requestId: created.id,
      creatorAccountId: creatorId,
      answer: '1 回目',
      attachmentKeys: [],
      now: NOW,
    });

    expect(
      await inquiries.answer({
        requestId: created.id,
        creatorAccountId: creatorId,
        answer: '2 回目',
        attachmentKeys: [],
        now: NOW,
      }),
    ).toBe(false);
    expect((await inquiries.findByRequest(created.id))?.answer).toBe('1 回目');
  });

  /*
    ⚠️ **依頼IDを知っている別の方が答えられない。** 作家さまのIDも条件に
       入れている。
  */
  it('別の方は答えられない', async () => {
    const created = await requests.create(newRequest());
    await inquiries.ask({
      id: randomUUID(),
      requestId: created.id,
      creatorAccountId: creatorId,
      dueAt: new Date('2026-08-27T00:00:00.000Z'),
      now: NOW,
    });
    expect(
      await inquiries.answer({
        requestId: created.id,
        creatorAccountId: buyerId,
        answer: '横から',
        attachmentKeys: [],
        now: NOW,
      }),
    ).toBe(false);
  });

  /** ⚠️ 依頼した瞬間に切れている期限を作らせない。 */
  it('依頼より前の期限を拒む', async () => {
    const created = await requests.create(newRequest());
    await expect(
      inquiries.ask({
        id: randomUUID(),
        requestId: created.id,
        creatorAccountId: creatorId,
        dueAt: new Date('2026-08-21T00:00:00.000Z'),
        now: NOW,
      }),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'creator_refund_inquiries_due_after_asked'),
    );
  });
});

suite('回収待ち', () => {
  /*
    ⚠️ **同じ注文で 2 行作らない。** 作れると、1 回の返金で二重に取り立てる
       ことになる。⚠️ ただし例外で処理を止めない（積めないことで返金が
       巻き戻るほうが困る）。
  */
  it('同じ注文で 2 行にならない。金額も書き換わらない', async () => {
    await receivables.record({
      id: randomUUID(),
      creatorAccountId: creatorId,
      orderId,
      amount: 5600,
      now: NOW,
    });
    await receivables.record({
      id: randomUUID(),
      creatorAccountId: creatorId,
      orderId,
      amount: 9999,
      now: NOW,
    });

    const rows = await receivables.listOutstanding(creatorId);
    expect(rows).toHaveLength(1);
    // ⚠️ 1 回目の記録が正。
    expect(rows[0]?.amount).toBe(5600);
  });

  it('決着させると、残高から外れる', async () => {
    const id = randomUUID();
    await receivables.record({
      id,
      creatorAccountId: creatorId,
      orderId,
      amount: 5600,
      now: NOW,
    });
    expect(
      await receivables.settle({ id, status: 'settled', actorAccountId: buyerId, now: NOW }),
    ).toBe(true);
    expect(await receivables.listOutstanding(creatorId)).toEqual([]);
  });

  /** ⚠️ 二度決着させない。 */
  it('二度目の決着は通らない', async () => {
    const id = randomUUID();
    await receivables.record({
      id,
      creatorAccountId: creatorId,
      orderId,
      amount: 5600,
      now: NOW,
    });
    await receivables.settle({ id, status: 'settled', actorAccountId: buyerId, now: NOW });
    expect(
      await receivables.settle({ id, status: 'written_off', actorAccountId: buyerId, now: NOW }),
    ).toBe(false);
  });

  it('0 円の回収待ちを拒む', async () => {
    await expect(
      receivables.record({
        id: randomUUID(),
        creatorAccountId: creatorId,
        orderId,
        amount: 0,
        now: NOW,
      }),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'creator_receivables_amount_positive'),
    );
  });
});
