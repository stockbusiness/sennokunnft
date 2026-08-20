import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../../generated/client';
import { PrismaClaimRepository } from '../../src/repositories/claim.repository';
import {
  createTestClient,
  integrationTestsAvailable,
  orderLineSeedFields,
  orderSeedFields,
  resetDatabase,
  violatesConstraint,
} from '../helpers/database';

/**
 * Claim の永続化を実 PostgreSQL に対して確かめる。
 *
 * ⚠️ **ここを Fake で済ませない。**
 * 確かめたいのは「同時に届いた 2 本のうち 1 本しか確定しない」ことで、
 * それを保証しているのは条件付き UPDATE の更新件数。
 * メモリ実装で確かめても意味がない。
 */
const enabled = integrationTestsAvailable();
const suite = enabled ? describe : describe.skip;

let prisma: PrismaClient;
let repo: PrismaClaimRepository;

const NOW = new Date('2026-08-14T00:00:00.000Z');
const PURCHASER_CU = 'cu_0123456789abcdef0123456789abcdef';
const OTHER_CU = 'cu_fedcba9876543210fedcba9876543210';

beforeAll(async () => {
  if (!enabled) return;
  prisma = createTestClient();
  await prisma.$connect();
  repo = new PrismaClaimRepository(prisma);
});

afterAll(async () => {
  if (!enabled) return;
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!enabled) return;
  await resetDatabase(prisma);
});

/** 受取権を 1 件だけ作る。購入者の common_user は引数で切り替える。 */
async function seedEntitlement(
  options: {
    commonUserId?: string | null;
    commonUserStatus?: string;
    tokenHash?: string;
  } = {},
): Promise<{ entitlementId: string; accountId: string; tokenHash: string }> {
  const accountId = randomUUID();
  const commonUserId = options.commonUserId === undefined ? PURCHASER_CU : options.commonUserId;
  const commonUserStatus =
    options.commonUserStatus ?? (commonUserId === null ? 'UNRESOLVED' : 'RESOLVED');
  await prisma.account.create({
    data: {
      id: accountId,
      authProvider: 'fake',
      authSubject: accountId,
      commonUserId,
      commonUserStatus,
      // RESOLVED を名乗る行には紐付け時刻が要る（accounts_common_user_resolved_has_id）。
      commonUserLinkedAt: commonUserStatus === 'RESOLVED' ? NOW : null,
    },
  });

  // 作品には持ち主が要る。この試験の関心事ではないので購入者と同じ人にしておく。
  const artwork = await prisma.artwork.create({
    data: {
      creatorAccountId: accountId,
      slug: `artwork-${randomUUID()}`,
      title: '天下布武の陣羽織',
      description: '',
      maxSupply: 10,
      status: 'published',
    },
  });
  const orderId = randomUUID();
  await prisma.order.create({
    data: {
      id: orderId,
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
      orderId,
      listingId: listing.id,
      artworkId: artwork.id,
      artworkTitleSnapshot: '天下布武の陣羽織',
      unitPriceAmount: 1000,
      unitPriceCurrency: 'JPY',
      quantity: 1,
      ...orderLineSeedFields({ creatorAccountId: accountId, unitPriceAmount: 1000, quantity: 1 }),
    },
  });
  const tokenHash = options.tokenHash ?? randomUUID();
  const entitlement = await prisma.entitlement.create({
    data: {
      orderId,
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

suite('Claim の照会', () => {
  it('トークンのハッシュで引ける', async () => {
    const { tokenHash, entitlementId } = await seedEntitlement();
    const found = await repo.findByTokenHash(tokenHash);
    expect(found?.entitlement.id).toBe(entitlementId);
    expect(found?.cardName).toBe('天下布武の陣羽織');
    expect(found?.entitlement.status).toBe('issued');
    expect(found?.entitlement.deliveryStatus).toBe('not_started');
  });

  it('知らないトークンは null（存在を漏らさない）', async () => {
    await seedEntitlement();
    expect(await repo.findByTokenHash(randomUUID())).toBeNull();
  });

  it('購入者が RESOLVED なら common_user_id を返す', async () => {
    const { tokenHash } = await seedEntitlement();
    const found = await repo.findByTokenHash(tokenHash);
    expect(found?.entitlement.purchaserCommonUserId).toBe(PURCHASER_CU);
  });

  it('購入者が未解決なら null を返す', async () => {
    const { tokenHash } = await seedEntitlement({ commonUserId: null });
    const found = await repo.findByTokenHash(tokenHash);
    expect(found?.entitlement.purchaserCommonUserId).toBeNull();
  });

  it('CONFLICT の行は、値があっても本人照合に使わない', async () => {
    // ⚠️ ここが緩むと、名寄せ候補が残ったままの人あてに受取先が決まる。
    const { tokenHash } = await seedEntitlement({
      commonUserId: PURCHASER_CU,
      commonUserStatus: 'CONFLICT',
    });
    const found = await repo.findByTokenHash(tokenHash);
    expect(found?.entitlement.purchaserCommonUserId).toBeNull();
  });

  it('PENDING の行も本人照合に使わない', async () => {
    const { tokenHash } = await seedEntitlement({
      commonUserId: null,
      commonUserStatus: 'PENDING',
    });
    const found = await repo.findByTokenHash(tokenHash);
    expect(found?.entitlement.purchaserCommonUserId).toBeNull();
  });
});

suite('受取の確定（同時に来ても 1 本だけ）', () => {
  it('確定すると claimed になり、配送待ちへ載る', async () => {
    const { entitlementId, accountId, tokenHash } = await seedEntitlement();
    const outcome = await repo.confirmClaim({
      entitlementId,
      commonUserId: PURCHASER_CU,
      accountId,
      now: NOW,
    });
    expect(outcome.kind).toBe('claimed');

    const found = await repo.findByTokenHash(tokenHash);
    expect(found?.entitlement.status).toBe('claimed');
    expect(found?.entitlement.deliveryStatus).toBe('pending');
    expect(found?.entitlement.claimedByCommonUserId).toBe(PURCHASER_CU);
  });

  it('同じ受取権を同時に確定しようとすると、通るのは 1 本だけ', async () => {
    const { entitlementId, accountId } = await seedEntitlement();
    const attempts = Array.from({ length: 8 }, () =>
      repo.confirmClaim({ entitlementId, commonUserId: PURCHASER_CU, accountId, now: NOW }),
    );
    const outcomes = await Promise.all(attempts);
    expect(outcomes.filter((o) => o.kind === 'claimed')).toHaveLength(1);
    expect(outcomes.filter((o) => o.kind === 'raced')).toHaveLength(7);
  });

  it('2 回目の確定は raced（受取権は 1 回しか使えない）', async () => {
    const { entitlementId, accountId } = await seedEntitlement();
    await repo.confirmClaim({ entitlementId, commonUserId: PURCHASER_CU, accountId, now: NOW });
    const second = await repo.confirmClaim({
      entitlementId,
      commonUserId: OTHER_CU,
      accountId,
      now: NOW,
    });
    expect(second.kind).toBe('raced');
  });

  it('取り消し済みの受取権は確定できない', async () => {
    const { entitlementId, accountId } = await seedEntitlement();
    await prisma.entitlement.update({
      where: { id: entitlementId },
      data: { status: 'revoked' },
    });
    const outcome = await repo.confirmClaim({
      entitlementId,
      commonUserId: PURCHASER_CU,
      accountId,
      now: NOW,
    });
    expect(outcome.kind).toBe('raced');
  });
});

suite('Claim の CHECK 制約', () => {
  it('知らない配送状態は入らない', async () => {
    const { entitlementId } = await seedEntitlement();
    await expect(
      prisma.entitlement.update({
        where: { id: entitlementId },
        data: { walletDeliveryStatus: 'shipped' },
      }),
    ).rejects.toSatisfy((error) =>
      violatesConstraint(error, 'entitlements_wallet_delivery_status_known'),
    );
  });

  it('契約と違う形式の common_user_id は入らない', async () => {
    const { entitlementId, accountId } = await seedEntitlement();
    await expect(
      prisma.entitlement.update({
        where: { id: entitlementId },
        data: {
          status: 'claimed',
          claimedByAccountId: accountId,
          claimedAt: NOW,
          claimedByCommonUserId: 'user-123',
        },
      }),
    ).rejects.toSatisfy((error) =>
      violatesConstraint(error, 'entitlements_claimed_common_user_id_format'),
    );
  });

  it('大文字の hex も拒否する（契約は小文字）', async () => {
    const { entitlementId, accountId } = await seedEntitlement();
    await expect(
      prisma.entitlement.update({
        where: { id: entitlementId },
        data: {
          status: 'claimed',
          claimedByAccountId: accountId,
          claimedAt: NOW,
          claimedByCommonUserId: 'cu_0123456789ABCDEF0123456789ABCDEF',
        },
      }),
    ).rejects.toSatisfy((error) =>
      violatesConstraint(error, 'entitlements_claimed_common_user_id_format'),
    );
  });

  it('受け取っていないのに配送中にできない', async () => {
    // ⚠️ ここが抜けると、受取の事実が無いまま「お届け中です」と答えることになる。
    const { entitlementId } = await seedEntitlement();
    await expect(
      prisma.entitlement.update({
        where: { id: entitlementId },
        data: { walletDeliveryStatus: 'pending' },
      }),
    ).rejects.toSatisfy((error) =>
      violatesConstraint(error, 'entitlements_delivery_requires_claim'),
    );
  });

  it('受け取っていないのに受取者を残せない', async () => {
    const { entitlementId } = await seedEntitlement();
    await expect(
      prisma.entitlement.update({
        where: { id: entitlementId },
        data: { claimedByCommonUserId: PURCHASER_CU },
      }),
    ).rejects.toSatisfy((error) =>
      violatesConstraint(error, 'entitlements_claimer_requires_claim'),
    );
  });

  it('issued へ戻すとき、配送状態を残したままにできない', async () => {
    // 状態だけを戻して配送状態が残ると、公開状態が矛盾する。
    const { entitlementId, accountId } = await seedEntitlement();
    await repo.confirmClaim({ entitlementId, commonUserId: PURCHASER_CU, accountId, now: NOW });
    await expect(
      prisma.entitlement.update({
        where: { id: entitlementId },
        // 受取者だけ先に消し、配送状態を残す。反応してよい制約を 1 つに絞る。
        data: { status: 'issued', claimedByCommonUserId: null },
      }),
    ).rejects.toSatisfy((error) =>
      violatesConstraint(error, 'entitlements_delivery_requires_claim'),
    );
  });

  it('issued へ戻すとき、受取者を残したままにできない', async () => {
    const { entitlementId, accountId } = await seedEntitlement();
    await repo.confirmClaim({ entitlementId, commonUserId: PURCHASER_CU, accountId, now: NOW });
    await expect(
      prisma.entitlement.update({
        where: { id: entitlementId },
        data: { status: 'issued', walletDeliveryStatus: 'not_started' },
      }),
    ).rejects.toSatisfy((error) =>
      violatesConstraint(error, 'entitlements_claimer_requires_claim'),
    );
  });
});

suite('受取URLの再発行（同時でも 1 本だけ）', () => {
  it('差し替えると旧トークンでは引けなくなる', async () => {
    // ⚠️ ここが残ると、漏れた URL がそのまま有効な受取口になる。
    const { entitlementId, accountId, tokenHash } = await seedEntitlement();
    const newHash = randomUUID();
    const rotated = await repo.rotateClaimToken({
      entitlementId,
      accountId,
      expectedTokenHash: tokenHash,
      newTokenHash: newHash,
      now: NOW,
    });
    expect(rotated).toBe(true);
    expect(await repo.findByTokenHash(tokenHash)).toBeNull();
    expect((await repo.findByTokenHash(newHash))?.entitlement.id).toBe(entitlementId);
  });

  it('同時に 8 本の再発行を試みても、成功は 1 本だけ', async () => {
    // ⚠️ 保存できるハッシュは 1 つ。負けた側のトークンは作られた瞬間から
    //    無効なので、「発行できました」と返してはいけない。
    const { entitlementId, accountId, tokenHash } = await seedEntitlement();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        repo.rotateClaimToken({
          entitlementId,
          accountId,
          expectedTokenHash: tokenHash,
          newTokenHash: randomUUID(),
          now: NOW,
        }),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('古いハッシュを条件にした差し替えは通らない', async () => {
    const { entitlementId, accountId, tokenHash } = await seedEntitlement();
    await repo.rotateClaimToken({
      entitlementId,
      accountId,
      expectedTokenHash: tokenHash,
      newTokenHash: randomUUID(),
      now: NOW,
    });
    const stale = await repo.rotateClaimToken({
      entitlementId,
      accountId,
      expectedTokenHash: tokenHash,
      newTokenHash: randomUUID(),
      now: NOW,
    });
    expect(stale).toBe(false);
  });

  it('別人のアカウントIDでは差し替えられない', async () => {
    const { entitlementId, tokenHash } = await seedEntitlement();
    const rotated = await repo.rotateClaimToken({
      entitlementId,
      accountId: randomUUID(),
      expectedTokenHash: tokenHash,
      newTokenHash: randomUUID(),
      now: NOW,
    });
    expect(rotated).toBe(false);
  });

  it('受取済みのものは差し替えられない', async () => {
    // できると、一度受け取ったあとにもう一度受け取れる経路ができる。
    const { entitlementId, accountId, tokenHash } = await seedEntitlement();
    await repo.confirmClaim({ entitlementId, commonUserId: PURCHASER_CU, accountId, now: NOW });
    const rotated = await repo.rotateClaimToken({
      entitlementId,
      accountId,
      expectedTokenHash: tokenHash,
      newTokenHash: randomUUID(),
      now: NOW,
    });
    expect(rotated).toBe(false);
  });

  it('再発行の判定に必要な情報を引ける', async () => {
    const { entitlementId, accountId } = await seedEntitlement();
    const found = await repo.findForReissue(entitlementId);
    expect(found?.accountId).toBe(accountId);
    expect(found?.status).toBe('issued');
  });

  it('知らない受取権IDは null', async () => {
    expect(await repo.findForReissue(randomUUID())).toBeNull();
  });
});

/**
 * 自動配送の取り出し（P0-2）。
 *
 * ⚠️ ここで確かめるのは**誰を拾うか**の一点。届けるかどうかの判定は
 * ドメイン（`evaluateAutoDelivery`）が持ち、単体試験が別にある。
 */
suite('自動配送の取り出し', () => {
  it('受取用のウォレットが結び付いている方の分を拾う', async () => {
    const { entitlementId } = await seedEntitlement({ commonUserId: PURCHASER_CU });
    const found = await repo.listAutoDeliverable(10);
    expect(found.map((row) => row.entitlement.id)).toEqual([entitlementId]);
  });

  it('まだ結び付いていない方の分は拾わない', async () => {
    // ⚠️ 拾うと、送る先が無いまま行列へ載る。
    await seedEntitlement({ commonUserId: null });
    expect(await repo.listAutoDeliverable(10)).toEqual([]);
  });

  it('名寄せ途中（CONFLICT）の行は拾わない', async () => {
    /*
      ⚠️ **ここが要。** `CONFLICT` の行にも値は入っている（運用で確認する
         ための手がかり）。値があることと、本人だと確定していることは別。
         拾うと、名寄せ途中の別人へ届く。
    */
    await seedEntitlement({ commonUserId: PURCHASER_CU, commonUserStatus: 'CONFLICT' });
    expect(await repo.listAutoDeliverable(10)).toEqual([]);
  });

  it('受け取り済みの分は拾わない', async () => {
    const { entitlementId } = await seedEntitlement({ commonUserId: PURCHASER_CU });
    await repo.confirmClaim({
      entitlementId,
      commonUserId: PURCHASER_CU,
      accountId: (await prisma.entitlement.findUniqueOrThrow({ where: { id: entitlementId } }))
        .accountId,
      now: NOW,
    });
    expect(await repo.listAutoDeliverable(10)).toEqual([]);
  });

  it('受取権IDから、受取トークンから引いたときと同じ材料が返る', async () => {
    /*
      ⚠️ **材料が食い違うと、人が受け取ったときと機械が届けたときで
         Wallet へ渡る本文が変わる。** 引き方を変えただけで中身が変わらない
         ことを、ここで留める。
    */
    const { entitlementId, tokenHash } = await seedEntitlement({ commonUserId: PURCHASER_CU });
    const byToken = await repo.findByTokenHash(tokenHash);
    const byId = await repo.findForAutoDelivery(entitlementId);
    expect(byId).toEqual(byToken);
  });

  it('存在しない受取権IDでは null を返す', async () => {
    expect(await repo.findForAutoDelivery(randomUUID())).toBeNull();
  });

  it('上限の数までしか拾わない', async () => {
    await seedEntitlement({ commonUserId: PURCHASER_CU });
    await seedEntitlement({ commonUserId: OTHER_CU });
    expect(await repo.listAutoDeliverable(1)).toHaveLength(1);
  });
});
