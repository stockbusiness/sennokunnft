import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../../generated/client';
import {
  PrismaAccountNoteRepository,
  PrismaCustomerDirectoryRepository,
  PrismaEmailChangeRequestRepository,
} from '../../src/repositories/customer.repository';
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
 * 顧客サポート（実運営 指示書 P1-1）を実 PostgreSQL に対して確かめる。
 *
 * ⚠️ ここで見たいのは 3 つ。
 *  1. **本人確認を飛ばして「済」にできないこと。** 飛ばされたことは、
 *     乗っ取られるまで誰にも分からない
 *  2. **決着していない申請が 1 件までであること。** 2 件並ぶと、どちらを
 *     本人確認したのか分からなくなる（部分 UNIQUE 索引）
 *  3. **集計が「成立したものだけ」を数えること。** 申し込んだだけの注文を
 *     売上に、申請中の返金を返金額に混ぜない
 */
const enabled = integrationTestsAvailable();
const suite = enabled ? describe : describe.skip;

const NOW = new Date('2026-08-21T00:00:00.000Z');
const PRICE = 12_000;
const MASKED = 't*****@e******.jp';

let prisma: PrismaClient;
let directory: PrismaCustomerDirectoryRepository;
let notes: PrismaAccountNoteRepository;
let emailChanges: PrismaEmailChangeRequestRepository;
let staffId: string;

beforeAll(() => {
  if (!enabled) return;
  prisma = createTestClient();
  directory = new PrismaCustomerDirectoryRepository(prisma);
  notes = new PrismaAccountNoteRepository(prisma);
  emailChanges = new PrismaEmailChangeRequestRepository(prisma);
});

afterAll(async () => {
  if (enabled) await prisma.$disconnect();
});

beforeEach(async () => {
  if (!enabled) return;
  await resetDatabase(prisma);
  staffId = randomUUID();
  await prisma.account.create({
    data: { id: staffId, authProvider: 'dev', authSubject: `staff-${staffId}`, role: 'operator' },
  });
});

async function seedAccount(
  overrides: { emailHash?: string; commonUserId?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await prisma.account.create({
    data: {
      id,
      authProvider: 'dev',
      authSubject: `buyer-${id}`,
      ...(overrides.emailHash === undefined ? {} : { emailHash: overrides.emailHash }),
      ...(overrides.commonUserId === undefined ? {} : { commonUserId: overrides.commonUserId }),
    },
  });
  return id;
}

/** 注文を 1 件つくる。⚠️ `paymentStatus` を渡して「成立前」も作れる。 */
async function seedOrder(
  accountId: string,
  options: { paymentStatus?: string; quantity?: number } = {},
): Promise<{ orderId: string; orderNumber: string; artworkId: string; orderLineId: string }> {
  const quantity = options.quantity ?? 1;
  const creatorAccountId = randomUUID();
  await prisma.account.create({
    data: {
      id: creatorAccountId,
      authProvider: 'dev',
      authSubject: `creator-${creatorAccountId}`,
    },
  });
  const artwork = await prisma.artwork.create({
    data: {
      creatorAccountId,
      slug: `artwork-${randomUUID()}`,
      title: 'サポートの試験の作品',
      maxSupply: 10,
      status: 'published',
    },
  });
  const listing = await prisma.listing.create({
    data: { artworkId: artwork.id, priceAmount: PRICE, priceCurrency: 'JPY' },
  });
  const paymentStatus = options.paymentStatus ?? 'succeeded';
  const paid = paymentStatus === 'succeeded';
  const order = await prisma.order.create({
    data: {
      accountId,
      totalAmount: PRICE * quantity,
      totalCurrency: 'JPY',
      idempotencyKey: randomUUID(),
      status: paid ? 'paid' : 'pending',
      paymentStatus,
      ...(paid ? { paidAt: NOW } : {}),
      ...orderSeedFields({ creatorAccountId, totalAmount: PRICE * quantity }),
      subtotalAmount: PRICE * quantity,
      creatorAmount: PRICE * quantity,
    },
  });
  const line = await prisma.orderLine.create({
    data: {
      orderId: order.id,
      listingId: listing.id,
      artworkId: artwork.id,
      artworkTitleSnapshot: 'サポートの試験の作品',
      unitPriceAmount: PRICE,
      unitPriceCurrency: 'JPY',
      quantity,
      ...orderLineSeedFields({ creatorAccountId, unitPriceAmount: PRICE, quantity }),
    },
  });
  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    artworkId: artwork.id,
    orderLineId: line.id,
  };
}

suite('要約', () => {
  it('何も無い方は 0 で返る（見つからない、にしない）', async () => {
    const accountId = await seedAccount();
    const summary = await directory.findByAccountId(accountId);
    expect(summary).not.toBeNull();
    expect(summary?.orderCount).toBe(0);
    expect(summary?.paidAmount).toBe(0);
    expect(summary?.firstOrderAt).toBeNull();
  });

  /*
    ⚠️ **申し込んだだけの注文を売上に混ぜない。** 混ぜると、応対中に
       「お支払いいただいた額」として読み上げられる。
  */
  it('お支払いが成立した注文だけを合計する', async () => {
    const accountId = await seedAccount();
    await seedOrder(accountId, { paymentStatus: 'succeeded' });
    await seedOrder(accountId, { paymentStatus: 'not_started' });

    const summary = await directory.findByAccountId(accountId);
    // ⚠️ 注文の件数は両方数える。数えないと履歴が消えて見える。
    expect(summary?.orderCount).toBe(2);
    expect(summary?.paidAmount).toBe(PRICE);
  });

  /*
    ⚠️ **申請中の返金を引かない。** 返っていないお金を返したことにしてしまう。
  */
  it('成立した返金だけを差し引く材料にする', async () => {
    const accountId = await seedAccount();
    const { orderId } = await seedOrder(accountId);
    await prisma.refund.createMany({
      data: [
        {
          orderId,
          amount: 5_000,
          currency: 'JPY',
          reason: 'buyer_request',
          initiatedBy: 'admin',
          actorAccountId: staffId,
          status: 'succeeded',
          // ⚠️ 成立した返金には、いつ成立したかが必ず入る（既存の CHECK）。
          settledAt: NOW,
        },
        {
          orderId,
          amount: 3_000,
          currency: 'JPY',
          reason: 'buyer_request',
          initiatedBy: 'admin',
          actorAccountId: staffId,
          status: 'requested',
        },
      ],
    });

    expect((await directory.findByAccountId(accountId))?.refundedAmount).toBe(5_000);
  });

  it('注文番号から辿れる', async () => {
    const accountId = await seedAccount();
    const { orderNumber } = await seedOrder(accountId);
    expect((await directory.findByOrderNumber(orderNumber))?.accountId).toBe(accountId);
  });

  it('無い注文番号では null', async () => {
    expect(await directory.findByOrderNumber('SNK-19990101-0001')).toBeNull();
  });

  it('照合用のメール値で引ける', async () => {
    const hash = `hash-${randomUUID()}`;
    const accountId = await seedAccount({ emailHash: hash });
    const found = await directory.findByEmailHash(hash, 10);
    expect(found.map((row) => row.accountId)).toEqual([accountId]);
  });

  /*
    ⚠️ **平文を持っていないので、伏せた表記も作れない。** 作れるふりを
       しないよう、`null` で返すことを試験で固定する。
  */
  it('要約にメールアドレスは入らない', async () => {
    const accountId = await seedAccount({ emailHash: `hash-${randomUUID()}` });
    const summary = await directory.findByAccountId(accountId);
    expect(summary?.maskedEmail).toBeNull();
    expect(JSON.stringify(summary)).not.toMatch(/@/);
  });
});

suite('受取権の一覧', () => {
  it('お受け取りの合言葉を返さない', async () => {
    const accountId = await seedAccount();
    const { orderId, orderLineId, artworkId } = await seedOrder(accountId);
    await prisma.entitlement.create({
      data: {
        orderId,
        orderLineId,
        artworkId,
        accountId,
        serialNo: 1,
        unitIndex: 0,
        claimTokenHash: `sha256:${'a'.repeat(64)}`,
        status: 'issued',
      },
    });

    const rows = await directory.entitlements(accountId, 10);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows).toLowerCase()).not.toContain('token');
  });

  /*
    ⚠️ **取り消したものを「未受取」に数えない。** 返金済みの品を
       「まだお受け取りいただけていません」と案内することになる。
  */
  it('取り消した受取権は未受取に数えない', async () => {
    const accountId = await seedAccount();
    const { orderId, orderLineId, artworkId } = await seedOrder(accountId, { quantity: 2 });
    await prisma.entitlement.createMany({
      data: [
        {
          orderId,
          orderLineId,
          artworkId,
          accountId,
          serialNo: 1,
          unitIndex: 0,
          claimTokenHash: `sha256:${'a'.repeat(64)}`,
          status: 'issued',
        },
        {
          orderId,
          orderLineId,
          artworkId,
          accountId,
          serialNo: 2,
          unitIndex: 1,
          claimTokenHash: `sha256:${'b'.repeat(64)}`,
          status: 'revoked',
        },
      ],
    });

    const summary = await directory.findByAccountId(accountId);
    expect(summary?.entitlementCount).toBe(2);
    expect(summary?.unclaimedCount).toBe(1);
  });
});

suite('同じ方かもしれないアカウント', () => {
  it('照合用のメール値が一致すれば候補に出る', async () => {
    const hash = `hash-${randomUUID()}`;
    const a = await seedAccount({ emailHash: hash });
    const b = await seedAccount({ emailHash: hash });

    const found = await directory.duplicateCandidates(a, 10);
    expect(found.map((row) => row.accountId)).toEqual([b]);
    expect(found[0]?.signals).toEqual(['email_hash']);
  });

  it('共通顧客IDが一致すれば候補に出る', async () => {
    const commonUserId = `cu_${randomUUID().replaceAll('-', '')}`;
    const a = await seedAccount({ commonUserId });
    const b = await seedAccount({ commonUserId });

    const found = await directory.duplicateCandidates(a, 10);
    expect(found.map((row) => row.accountId)).toEqual([b]);
    expect(found[0]?.signals).toEqual(['common_user_id']);
  });

  it('両方一致すれば手がかりが 2 つ付く', async () => {
    const hash = `hash-${randomUUID()}`;
    const commonUserId = `cu_${randomUUID().replaceAll('-', '')}`;
    const a = await seedAccount({ emailHash: hash, commonUserId });
    await seedAccount({ emailHash: hash, commonUserId });

    const found = await directory.duplicateCandidates(a, 10);
    expect(found[0]?.signals).toEqual(['email_hash', 'common_user_id']);
  });

  /*
    ⚠️ **自分自身を候補にしない。** 画面に「自分と同じ人です」と出て、
       読んだ人が混乱する。
  */
  it('自分自身は候補に出ない', async () => {
    const hash = `hash-${randomUUID()}`;
    const a = await seedAccount({ emailHash: hash });
    expect(await directory.duplicateCandidates(a, 10)).toEqual([]);
  });

  /*
    ⚠️ **手がかりが無ければ探さない。** 探すと無関係な人が並ぶ。
  */
  it('手がかりが無ければ候補を出さない', async () => {
    const a = await seedAccount();
    await seedAccount();
    expect(await directory.duplicateCandidates(a, 10)).toEqual([]);
  });
});

suite('アカウント単位の申し送り', () => {
  it('書ける', async () => {
    const accountId = await seedAccount();
    await notes.add({
      accountId,
      authorAccountId: staffId,
      body: '別のアカウントでも購入されている可能性があります。',
      now: NOW,
    });
    const rows = await notes.list(accountId, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.authorAccountId).toBe(staffId);
  });

  /*
    ⚠️ **空行が並ぶと、読む人が全部読み飛ばす。**
  */
  it('空のメモは DB が拒む', async () => {
    const accountId = await seedAccount();
    await expect(
      prisma.accountNote.create({
        data: { accountId, authorAccountId: staffId, body: '   ', createdAt: NOW },
      }),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'account_notes_body_present'),
    );
  });
});

suite('ご連絡先の変更申請', () => {
  async function open(accountId: string): Promise<string> {
    return emailChanges.open({
      accountId,
      requestedMaskedEmail: MASKED,
      requestedEmailHash: `hash-${randomUUID()}`,
      openedByAccountId: staffId,
      now: NOW,
    });
  }

  it('申し出を記録できる', async () => {
    const accountId = await seedAccount();
    const id = await open(accountId);
    const row = await emailChanges.findById(id);
    expect(row?.status).toBe('requested');
    expect(row?.requestedMaskedEmail).toBe(MASKED);
  });

  /*
    ⚠️ **2 件並ぶと、どちらを本人確認したのか分からなくなる。**
  */
  it('決着していない申請は 1 件まで', async () => {
    const accountId = await seedAccount();
    await open(accountId);
    await expect(open(accountId)).rejects.toSatisfy((error: unknown) =>
      violatesUniqueConstraint(error),
    );
  });

  it('決着すれば、次の申請を出せる', async () => {
    const accountId = await seedAccount();
    const id = await open(accountId);
    await emailChanges.settle({
      id,
      status: 'rejected',
      note: '取り下げのご連絡がありました。',
      actorAccountId: staffId,
      now: NOW,
    });
    await expect(open(accountId)).resolves.toBeTruthy();
  });

  /*
    ⚠️ **この試験がこの表の存在理由。** アプリの判定に穴が開いたときに
       残る最後の砦。飛ばされたことは、乗っ取られるまで誰にも分からない。
  */
  it('本人確認なしに「済」へは進めない（DB が拒む）', async () => {
    const accountId = await seedAccount();
    const id = await open(accountId);
    await expect(
      prisma.emailChangeRequest.update({
        where: { id },
        data: {
          status: 'completed',
          settledByAccountId: staffId,
          settledAt: NOW,
        },
      }),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'email_change_requests_completed_requires_verification'),
    );
  });

  it('本人確認を経れば「済」へ進める', async () => {
    const accountId = await seedAccount();
    const id = await open(accountId);
    await emailChanges.verify({
      id,
      method: 'order_details_match',
      note: 'ご注文番号と金額が一致しました。',
      actorAccountId: staffId,
      now: NOW,
    });
    await emailChanges.settle({
      id,
      status: 'completed',
      note: '認証基盤側で変更しました。',
      actorAccountId: staffId,
      now: NOW,
    });

    const row = await emailChanges.findById(id);
    expect(row?.status).toBe('completed');
    expect(row?.verificationMethod).toBe('order_details_match');
    expect(row?.verifiedByAccountId).toBe(staffId);
  });

  /*
    ⚠️ **決着した申請は動かない。** 条件付き UPDATE なので、同時に
       2 人が押しても片方しか通らない。
  */
  it('決着した申請は、あとから動かない', async () => {
    const accountId = await seedAccount();
    const id = await open(accountId);
    await emailChanges.settle({
      id,
      status: 'rejected',
      note: '本人確認が取れませんでした。',
      actorAccountId: staffId,
      now: NOW,
    });

    await emailChanges.verify({
      id,
      method: 'identity_document',
      note: null,
      actorAccountId: staffId,
      now: NOW,
    });

    expect((await emailChanges.findById(id))?.status).toBe('rejected');
  });

  /*
    ⚠️ **伏せていない宛先を保存させない**（`UD-503`）。
  */
  it('伏せていない宛先は DB が拒む', async () => {
    const accountId = await seedAccount();
    await expect(
      prisma.emailChangeRequest.create({
        data: {
          accountId,
          requestedMaskedEmail: 'tanaka@example.jp',
          requestedEmailHash: `hash-${randomUUID()}`,
          openedByAccountId: staffId,
          createdAt: NOW,
          updatedAt: NOW,
        },
      }),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'email_change_requests_masked_recipient'),
    );
  });

  it('理由の無い見送りは DB が拒む', async () => {
    const accountId = await seedAccount();
    const id = await open(accountId);
    await expect(
      prisma.emailChangeRequest.update({
        where: { id },
        data: {
          status: 'rejected',
          settledByAccountId: staffId,
          settledAt: NOW,
          note: null,
        },
      }),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'email_change_requests_rejection_has_note'),
    );
  });
});
