import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { assertStagingFixtureAllowed, UnsafeEnvironmentError } from '@sengoku/config';
import { createPrismaClient, type PrismaClient } from '@sengoku/database';
import { FixedClock, Sha256ClaimTokenService } from '@sengoku/integrations';
import { createStagingEntitlement, StagingFixtureError } from '../src/staging-fixture';

/**
 * staging Fixture の安全装置と生成内容を確かめる（PR-NW04 §7・§8・§9）。
 *
 * ⚠️ **本番拒否のテストを飛ばさない。**
 * ここが素通りすると、本番DBに偽の受取権が作れる経路が残る。
 * しかもその事実は、誰かが気づくまで表に出ない。
 */

const NOW = new Date('2026-08-14T00:00:00.000Z');
const PURCHASER_CU = 'cu_0123456789abcdef0123456789abcdef';
const CLAIM_BASE_URL = 'https://market-stg.example.jp/claims';

describe('実行の可否（§9）', () => {
  // ⚠️ **2 つの条件を両方満たしたときにだけ通す。**
  //    フラグ 1 本にすると、本番の環境変数へ 1 行足しただけで
  //    本番DBに偽の受取権が作れてしまう。
  it('本番かつフラグありでも拒否する', () => {
    expect(() =>
      assertStagingFixtureAllowed({
        NODE_ENV: 'production',
        APP_ENV: 'production',
        ENABLE_STAGING_FIXTURES: true,
      }),
    ).toThrow(UnsafeEnvironmentError);
  });

  it('APP_ENV だけが production でも拒否する', () => {
    expect(() =>
      assertStagingFixtureAllowed({
        NODE_ENV: 'development',
        APP_ENV: 'production',
        ENABLE_STAGING_FIXTURES: true,
      }),
    ).toThrow(UnsafeEnvironmentError);
  });

  it('本番でなくてもフラグが無ければ拒否する', () => {
    expect(() =>
      assertStagingFixtureAllowed({
        NODE_ENV: 'development',
        APP_ENV: 'staging',
        ENABLE_STAGING_FIXTURES: false,
      }),
    ).toThrow(UnsafeEnvironmentError);
  });

  it('両方そろったときだけ通す', () => {
    expect(() =>
      assertStagingFixtureAllowed({
        NODE_ENV: 'development',
        APP_ENV: 'staging',
        ENABLE_STAGING_FIXTURES: true,
      }),
    ).not.toThrow();
  });
});

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const enabled = (() => {
  const required = process.env.REQUIRE_INTEGRATION_TESTS === '1' || process.env.CI === 'true';
  if (testDatabaseUrl === undefined || testDatabaseUrl === '') {
    if (required) {
      throw new Error(
        '結合テストが必須の環境ですが TEST_DATABASE_URL が設定されていません。黙って飛ばさないため、失敗させます。',
      );
    }
    return false;
  }
  return true;
})();
const suite = enabled ? describe : describe.skip;

let prisma: PrismaClient;

beforeAll(async () => {
  if (!enabled) return;
  prisma = (await createPrismaClient({ databaseUrl: testDatabaseUrl ?? '' })) as PrismaClient;
  await prisma.$connect();
});

afterAll(async () => {
  if (!enabled) return;
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!enabled) return;
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      nft_tokens, mint_jobs, entitlements, order_lines, payments, orders,
      wallet_delivery_outbox, listings, artworks, idempotency_keys, hmac_nonces, accounts,
      webhook_events, outbox_events, audit_logs
    RESTART IDENTITY CASCADE
  `);
});

function deps() {
  return {
    prisma,
    tokens: new Sha256ClaimTokenService(),
    clock: new FixedClock(NOW),
    claimBaseUrl: CLAIM_BASE_URL,
  };
}

async function seedAccount(
  options: { commonUserStatus?: string; commonUserId?: string | null } = {},
): Promise<string> {
  const id = randomUUID();
  const status = options.commonUserStatus ?? 'RESOLVED';
  await prisma.account.create({
    data: {
      id,
      authProvider: 'fake',
      authSubject: id,
      commonUserId: options.commonUserId === undefined ? PURCHASER_CU : options.commonUserId,
      commonUserStatus: status,
      commonUserLinkedAt: status === 'RESOLVED' ? NOW : null,
    },
  });
  return id;
}

async function seedArtwork(maxSupply = 10): Promise<string> {
  // 作品には持ち主が要る。この試験の関心事ではないので器を1つ用意する。
  const creatorAccountId = randomUUID();
  await prisma.account.create({
    data: { id: creatorAccountId, authProvider: 'fake', authSubject: creatorAccountId },
  });
  const artwork = await prisma.artwork.create({
    data: {
      creatorAccountId,
      slug: `artwork-${randomUUID()}`,
      title: '天下布武の陣羽織',
      maxSupply,
      status: 'published',
    },
  });
  return artwork.id;
}

suite('前提の確認', () => {
  it('アカウントが無ければ作らない', async () => {
    const artworkId = await seedArtwork();
    await expect(
      createStagingEntitlement(deps(), { accountId: randomUUID(), artworkId }),
    ).rejects.toThrow(StagingFixtureError);
    expect(await prisma.entitlement.count()).toBe(0);
  });

  it('共通顧客IDが未解決なら作らない', async () => {
    // ⚠️ ここを飛ばすと「作れたのに受け取れない」データができ、
    //    原因の切り分けに時間を使う。
    const accountId = await seedAccount({ commonUserStatus: 'UNRESOLVED', commonUserId: null });
    const artworkId = await seedArtwork();
    await expect(createStagingEntitlement(deps(), { accountId, artworkId })).rejects.toThrow(
      StagingFixtureError,
    );
    expect(await prisma.entitlement.count()).toBe(0);
  });

  it('CONFLICT でも作らない（曖昧なまま渡さない）', async () => {
    const accountId = await seedAccount({ commonUserStatus: 'CONFLICT' });
    const artworkId = await seedArtwork();
    await expect(createStagingEntitlement(deps(), { accountId, artworkId })).rejects.toThrow(
      StagingFixtureError,
    );
  });

  it('作品が無ければ作らない', async () => {
    const accountId = await seedAccount();
    await expect(
      createStagingEntitlement(deps(), { accountId, artworkId: randomUUID() }),
    ).rejects.toThrow(StagingFixtureError);
  });

  it('発行上限を超えては作らない', async () => {
    const accountId = await seedAccount();
    const artworkId = await seedArtwork(1);
    await createStagingEntitlement(deps(), { accountId, artworkId });
    await expect(createStagingEntitlement(deps(), { accountId, artworkId })).rejects.toThrow(
      StagingFixtureError,
    );
  });
});

suite('生成される内容（§7）', () => {
  it('Order / OrderLine / Entitlement をそろえて作る', async () => {
    const accountId = await seedAccount();
    const artworkId = await seedArtwork();

    const result = await createStagingEntitlement(deps(), { accountId, artworkId });

    const entitlement = await prisma.entitlement.findUniqueOrThrow({
      where: { id: result.entitlementId },
    });
    // ⚠️ NOT NULL を緩めていないので、注文が無い受取権は作れない。
    expect(entitlement.orderId).toBe(result.orderId);
    expect(entitlement.orderLineId).toBe(result.orderLineId);
    expect(entitlement.status).toBe('issued');
  });

  it('出自を STAGING_FIXTURE として記録する', async () => {
    const accountId = await seedAccount();
    const artworkId = await seedArtwork();

    const result = await createStagingEntitlement(deps(), { accountId, artworkId });

    const order = await prisma.order.findUniqueOrThrow({ where: { id: result.orderId } });
    expect(order.source).toBe('STAGING_FIXTURE');
  });

  it('決済に関わるものを一切作らない（§9）', async () => {
    const accountId = await seedAccount();
    const artworkId = await seedArtwork();

    const result = await createStagingEntitlement(deps(), { accountId, artworkId });

    // Payment を作らない。決済済みを装わない。
    expect(await prisma.payment.count()).toBe(0);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: result.orderId } });
    expect(order.status).toBe('pending');
    expect(order.paidAt).toBeNull();
    // 金額は最小額（`listings_price_positive` を満たすため）。請求は発生しない。
    expect(order.totalAmount).toBe(1);
    // Mint も行わない。
    expect(await prisma.mintJob.count()).toBe(0);
    expect(await prisma.nftToken.count()).toBe(0);
  });

  it('Claim URL を出力し、平文のトークンを保存しない', async () => {
    const accountId = await seedAccount();
    const artworkId = await seedArtwork();

    const result = await createStagingEntitlement(deps(), { accountId, artworkId });

    expect(result.claimUrl.startsWith(`${CLAIM_BASE_URL}/`)).toBe(true);
    const token = result.claimUrl.slice(CLAIM_BASE_URL.length + 1);
    expect(token.length).toBeGreaterThan(20);

    const entitlement = await prisma.entitlement.findUniqueOrThrow({
      where: { id: result.entitlementId },
    });
    // ⚠️ 保存されているのはハッシュだけ。
    expect(entitlement.claimTokenHash).not.toBe(token);
    expect(entitlement.claimTokenHash).toBe(new Sha256ClaimTokenService().hash(token));
  });

  it('在庫の発行済み数を進める', async () => {
    const accountId = await seedAccount();
    const artworkId = await seedArtwork();

    await createStagingEntitlement(deps(), { accountId, artworkId });

    const artwork = await prisma.artwork.findUniqueOrThrow({ where: { id: artworkId } });
    expect(artwork.issuedCount).toBe(1);
    // 仮引当は残さない（発行まで一気に進める）。
    expect(artwork.reservedCount).toBe(0);
  });
});

suite('シリアル番号の採番', () => {
  it('連番になる', async () => {
    const accountId = await seedAccount();
    const artworkId = await seedArtwork();

    const first = await createStagingEntitlement(deps(), { accountId, artworkId });
    const second = await createStagingEntitlement(deps(), { accountId, artworkId });

    expect([first.serialNumber, second.serialNumber]).toEqual([1, 2]);
  });

  it('同時に走らせても番号が重複しない', async () => {
    // ⚠️ 作品行をロックせずに採番すると、同時実行で同じ番号を採る。
    //    UNIQUE 制約が最後に止めるが、staging で「たまに失敗する」挙動は
    //    本番の不具合と見分けがつかない。
    const accountId = await seedAccount();
    const artworkId = await seedArtwork(20);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => createStagingEntitlement(deps(), { accountId, artworkId })),
    );

    const serials = results.map((result) => result.serialNumber).sort((a, b) => a - b);
    expect(serials).toEqual([1, 2, 3, 4, 5]);
  });
});
