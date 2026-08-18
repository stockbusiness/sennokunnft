import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../../generated/client';
import {
  createTestClient,
  integrationTestsAvailable,
  resetDatabase,
  violatesConstraint,
  violatesUniqueConstraint,
} from '../helpers/database';

/**
 * 実 PostgreSQL に対する制約の検証（TEST_STRATEGY.md §3.2 M-1/M-2、§3.3 S-4）。
 *
 * Phase 1 ではスキーマ上に制約が「書かれている」ことを静的に検査していた。
 * ここでは実際に「効く」ことを確かめる。
 * 書いてあるのに効いていない（マイグレーション漏れ）を検出するのが目的。
 */
const enabled = integrationTestsAvailable();
const suite = enabled ? describe : describe.skip;

let prisma: PrismaClient;

beforeAll(async () => {
  if (!enabled) return;
  prisma = createTestClient();
  await prisma.$connect();
});

afterAll(async () => {
  if (!enabled) return;
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!enabled) return;
  await resetDatabase(prisma);
});

/** 作品には持ち主が要る。制約の試験では中身を問わないので、器を1つ用意する。 */
async function seedAccount(): Promise<string> {
  const id = randomUUID();
  await prisma.account.create({ data: { id, authProvider: 'fake', authSubject: id } });
  return id;
}

async function seedArtwork(overrides: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await prisma.artwork.create({
    data: {
      id,
      creatorAccountId: await seedAccount(),
      slug: `artwork-${id.slice(0, 8)}`,
      title: 'テスト作品',
      maxSupply: 10,
      imageKey: 'images/test.png',
      imageContentType: 'image/png',
      imageByteSize: 1024,
      status: 'published',
      ...overrides,
    },
  });
  return id;
}

suite('在庫の CHECK 制約（S-4: オーバーセルの最終防壁）', () => {
  it('上限ちょうどまでは更新できる', async () => {
    const id = await seedArtwork({ maxSupply: 10 });
    await prisma.artwork.update({
      where: { id },
      data: { reservedCount: 4, issuedCount: 6 },
    });
    const row = await prisma.artwork.findUniqueOrThrow({ where: { id } });
    expect(row.reservedCount + row.issuedCount).toBe(10);
  });

  it('上限を 1 超えると DB が拒否する', async () => {
    // アプリの行ロック実装に穴があっても、ここで止まる。
    const id = await seedArtwork({ maxSupply: 10 });
    await expect(
      prisma.artwork.update({ where: { id }, data: { reservedCount: 5, issuedCount: 6 } }),
    ).rejects.toSatisfy((error) => violatesConstraint(error, 'artworks_supply_within_max'));
  });

  it('作成時点で上限を超えていれば拒否する', async () => {
    await expect(seedArtwork({ maxSupply: 2, reservedCount: 2, issuedCount: 1 })).rejects.toSatisfy(
      (error) => violatesConstraint(error, 'artworks_supply_within_max'),
    );
  });

  it('負の在庫を拒否する', async () => {
    const id = await seedArtwork();
    await expect(
      prisma.artwork.update({ where: { id }, data: { reservedCount: -1 } }),
    ).rejects.toSatisfy((error) =>
      violatesConstraint(error, 'artworks_reserved_count_non_negative'),
    );
  });

  it('発行上限 0 の作品を作れない', async () => {
    await expect(seedArtwork({ maxSupply: 0 })).rejects.toSatisfy((error) =>
      violatesConstraint(error, 'artworks_max_supply_positive'),
    );
  });

  it('同時更新でも合計が上限を超えない', async () => {
    // 在庫 1 に対して 2 つの引当を同時に投げる。
    // アプリ側のロックがない状態でも、DB が少なくとも一方を落とす。
    const id = await seedArtwork({ maxSupply: 1 });
    const results = await Promise.allSettled([
      prisma.artwork.update({ where: { id }, data: { reservedCount: { increment: 1 } } }),
      prisma.artwork.update({ where: { id }, data: { reservedCount: { increment: 1 } } }),
    ]);

    const succeeded = results.filter((result) => result.status === 'fulfilled').length;
    expect(succeeded).toBe(1);

    const row = await prisma.artwork.findUniqueOrThrow({ where: { id } });
    expect(row.reservedCount + row.issuedCount).toBeLessThanOrEqual(row.maxSupply);
  });
});

suite('出品の CHECK 制約', () => {
  it('負の価格を拒否する', async () => {
    const artworkId = await seedArtwork();
    await expect(
      prisma.listing.create({
        data: { artworkId, priceAmount: -1, priceCurrency: 'JPY' },
      }),
    ).rejects.toSatisfy((error) => violatesConstraint(error, 'listings_price_positive'));
  });

  it('販売期間が逆転していれば拒否する', async () => {
    const artworkId = await seedArtwork();
    await expect(
      prisma.listing.create({
        data: {
          artworkId,
          priceAmount: 100,
          priceCurrency: 'JPY',
          startsAt: new Date('2026-07-01T00:00:00Z'),
          endsAt: new Date('2026-06-01T00:00:00Z'),
        },
      }),
    ).rejects.toSatisfy((error) => violatesConstraint(error, 'listings_period_ordered'));
  });

  it('1 注文あたりの数量上限に 0 を許さない', async () => {
    const artworkId = await seedArtwork();
    await expect(
      prisma.listing.create({
        data: { artworkId, priceAmount: 100, priceCurrency: 'JPY', maxQuantityPerOrder: 0 },
      }),
    ).rejects.toSatisfy((error) => violatesConstraint(error, 'listings_max_quantity_positive'));
  });
});

suite('作品の持ち主（UD-102 決定変更）', () => {
  it('持ち主のいない作品は保存できない', async () => {
    // ⚠️ 持ち主が決まらない行を許すと、誰が触ってよいかを判定できない。
    //    判定できない行は「とりあえず通す」に倒れやすく、それが穴になる。
    await expect(
      prisma.artwork.create({
        data: { slug: `orphan-${randomUUID()}`, title: 'x', maxSupply: 1 } as never,
      }),
    ).rejects.toThrow();
  });

  it('実在しないアカウントを持ち主にできない', async () => {
    await expect(
      prisma.artwork.create({
        data: {
          creatorAccountId: randomUUID(),
          slug: `ghost-${randomUUID()}`,
          title: 'x',
          maxSupply: 1,
        },
      }),
    ).rejects.toThrow();
  });

  it('作品を持ったままのアカウントは消せない（ON DELETE RESTRICT）', async () => {
    // ⚠️ CASCADE にすると、アカウントを消した拍子に売れた作品まで消え、
    //    注文の履歴と食い違う。消せないほうを正しいとする。
    const creatorAccountId = await seedAccount();
    await prisma.artwork.create({
      data: { creatorAccountId, slug: `kept-${randomUUID()}`, title: 'x', maxSupply: 1 },
    });

    await expect(prisma.account.delete({ where: { id: creatorAccountId } })).rejects.toThrow();
  });
});

suite('一意制約', () => {
  it('slug は重複できない', async () => {
    const creatorAccountId = await seedAccount();
    await prisma.artwork.create({
      data: { creatorAccountId, slug: 'duplicate', title: 'A', maxSupply: 1 },
    });
    await expect(
      prisma.artwork.create({
        data: { creatorAccountId, slug: 'duplicate', title: 'B', maxSupply: 1 },
      }),
    ).rejects.toSatisfy(violatesUniqueConstraint);
  });
});

suite('返金額の CHECK 制約', () => {
  it('支払額を超える返金を拒否する', async () => {
    const accountId = randomUUID();
    await prisma.account.create({
      data: { id: accountId, authProvider: 'fake', authSubject: accountId },
    });
    const orderId = randomUUID();
    await prisma.order.create({
      data: {
        id: orderId,
        accountId,
        totalAmount: 1000,
        totalCurrency: 'JPY',
        idempotencyKey: randomUUID(),
      },
    });

    await expect(
      prisma.payment.create({
        data: {
          orderId,
          provider: 'fake',
          amount: 1000,
          currency: 'JPY',
          amountRefunded: 2000,
        },
      }),
    ).rejects.toSatisfy((error) => violatesConstraint(error, 'payments_refund_within_amount'));
  });
});

suite('受取権の CHECK 制約', () => {
  it('claimed なのに受取者が空の行を作れない', async () => {
    // 状態列と実データが食い違うと、監査でも復旧でも判断できなくなる。
    const accountId = randomUUID();
    await prisma.account.create({
      data: { id: accountId, authProvider: 'fake', authSubject: accountId },
    });
    const artworkId = await seedArtwork();
    const orderId = randomUUID();
    await prisma.order.create({
      data: {
        id: orderId,
        accountId,
        totalAmount: 1000,
        totalCurrency: 'JPY',
        idempotencyKey: randomUUID(),
      },
    });
    const listing = await prisma.listing.create({
      data: { artworkId, priceAmount: 1000, priceCurrency: 'JPY' },
    });
    const line = await prisma.orderLine.create({
      data: {
        orderId,
        listingId: listing.id,
        artworkId,
        artworkTitleSnapshot: 'テスト作品',
        unitPriceAmount: 1000,
        unitPriceCurrency: 'JPY',
        quantity: 1,
      },
    });

    await expect(
      prisma.entitlement.create({
        data: {
          orderId,
          orderLineId: line.id,
          artworkId,
          accountId,
          serialNo: 1,
          claimTokenHash: randomUUID(),
          status: 'claimed',
        },
      }),
    ).rejects.toSatisfy((error) =>
      violatesConstraint(error, 'entitlements_claimed_fields_present'),
    );
  });

  it('シリアル番号 0 を拒否する', async () => {
    const accountId = randomUUID();
    await prisma.account.create({
      data: { id: accountId, authProvider: 'fake', authSubject: accountId },
    });
    const artworkId = await seedArtwork();
    const orderId = randomUUID();
    await prisma.order.create({
      data: {
        id: orderId,
        accountId,
        totalAmount: 0,
        totalCurrency: 'JPY',
        idempotencyKey: randomUUID(),
      },
    });
    const listing = await prisma.listing.create({
      data: { artworkId, priceAmount: 1000, priceCurrency: 'JPY' },
    });
    const line = await prisma.orderLine.create({
      data: {
        orderId,
        listingId: listing.id,
        artworkId,
        artworkTitleSnapshot: 'テスト作品',
        unitPriceAmount: 0,
        unitPriceCurrency: 'JPY',
        quantity: 1,
      },
    });

    await expect(
      prisma.entitlement.create({
        data: {
          orderId,
          orderLineId: line.id,
          artworkId,
          accountId,
          serialNo: 0,
          claimTokenHash: randomUUID(),
        },
      }),
    ).rejects.toSatisfy((error) => violatesConstraint(error, 'entitlements_serial_no_positive'));
  });
});

suite('出品の新しい制約（Phase 2）', () => {
  it('0 円の出品を拒否する', async () => {
    // 無償配布は「販売」とは別の導線として扱う。
    const artworkId = await seedArtwork();
    await expect(
      prisma.listing.create({ data: { artworkId, priceAmount: 0, priceCurrency: 'JPY' } }),
    ).rejects.toSatisfy((error) => violatesConstraint(error, 'listings_price_positive'));
  });

  it('1 円の出品は作れる（境界）', async () => {
    const artworkId = await seedArtwork();
    const listing = await prisma.listing.create({
      data: { artworkId, priceAmount: 1, priceCurrency: 'JPY' },
    });
    expect(listing.priceAmount).toBe(1);
  });

  it('公開されていない作品に有効な出品を作れない（トリガ）', async () => {
    // 作品と出品は別テーブルなので CHECK では表現できず、トリガで担保している。
    const artworkId = await seedArtwork({ status: 'draft' });
    await expect(
      prisma.listing.create({
        data: { artworkId, priceAmount: 1000, priceCurrency: 'JPY', status: 'active' },
      }),
    ).rejects.toSatisfy((error) => violatesConstraint(error, 'listings_require_published_artwork'));
  });

  it('非公開作品にも有効な出品を作れない', async () => {
    const artworkId = await seedArtwork({ status: 'archived' });
    await expect(
      prisma.listing.create({
        data: { artworkId, priceAmount: 1000, priceCurrency: 'JPY', status: 'active' },
      }),
    ).rejects.toSatisfy((error) => violatesConstraint(error, 'listings_require_published_artwork'));
  });

  it('下書きの出品なら未公開の作品にも作れる（準備は先にできる）', async () => {
    const artworkId = await seedArtwork({ status: 'draft' });
    const listing = await prisma.listing.create({
      data: { artworkId, priceAmount: 1000, priceCurrency: 'JPY', status: 'draft' },
    });
    expect(listing.status).toBe('draft');
  });

  it('同一作品に有効な出品を 2 件作れない（部分ユニーク索引）', async () => {
    const artworkId = await seedArtwork();
    await prisma.listing.create({
      data: { artworkId, priceAmount: 1000, priceCurrency: 'JPY', status: 'active' },
    });
    await expect(
      prisma.listing.create({
        data: { artworkId, priceAmount: 2000, priceCurrency: 'JPY', status: 'active' },
      }),
    ).rejects.toSatisfy(violatesUniqueConstraint);
  });

  it('販売予定も「有効」として数える', async () => {
    const artworkId = await seedArtwork();
    await prisma.listing.create({
      data: {
        artworkId,
        priceAmount: 1000,
        priceCurrency: 'JPY',
        status: 'scheduled',
        startsAt: new Date(Date.now() + 86_400_000),
      },
    });
    await expect(
      prisma.listing.create({
        data: { artworkId, priceAmount: 2000, priceCurrency: 'JPY', status: 'active' },
      }),
    ).rejects.toSatisfy(violatesUniqueConstraint);
  });

  it('下書き・終了済みは何件でも作れる（履歴として残す）', async () => {
    const artworkId = await seedArtwork();
    await prisma.listing.create({
      data: { artworkId, priceAmount: 1000, priceCurrency: 'JPY', status: 'draft' },
    });
    await prisma.listing.create({
      data: { artworkId, priceAmount: 2000, priceCurrency: 'JPY', status: 'ended' },
    });
    await prisma.listing.create({
      data: { artworkId, priceAmount: 3000, priceCurrency: 'JPY', status: 'ended' },
    });
    expect(await prisma.listing.count({ where: { artworkId } })).toBe(3);
  });

  it('開始日時のない販売予定を拒否する', async () => {
    // 「scheduled かつ開始日時を過ぎている＝販売中」と扱うので、
    // 開始日時が無いと判定が曖昧になる。
    const artworkId = await seedArtwork();
    await expect(
      prisma.listing.create({
        data: { artworkId, priceAmount: 1000, priceCurrency: 'JPY', status: 'scheduled' },
      }),
    ).rejects.toSatisfy((error) => violatesConstraint(error, 'listings_scheduled_requires_start'));
  });
});

suite('作品の画像メタデータ', () => {
  it('キーだけあってサイズが無い状態を拒否する', async () => {
    // 中途半端な状態を許すと、表示側が null の組み合わせを毎回考えることになる。
    await expect(
      seedArtwork({ imageKey: 'artworks/x.png', imageContentType: null, imageByteSize: null }),
    ).rejects.toSatisfy((error) => violatesConstraint(error, 'artworks_image_fields_consistent'));
  });

  it('3 つとも揃っていれば作れる', async () => {
    const id = await seedArtwork({
      imageKey: 'artworks/x.png',
      imageContentType: 'image/png',
      imageByteSize: 2048,
    });
    const row = await prisma.artwork.findUniqueOrThrow({ where: { id } });
    expect(row.imageByteSize).toBe(2048);
  });

  it('3 つとも無い状態も作れる（画像は後から登録する）', async () => {
    const id = await seedArtwork({ imageKey: null, imageContentType: null, imageByteSize: null });
    const row = await prisma.artwork.findUniqueOrThrow({ where: { id } });
    expect(row.imageKey).toBeNull();
  });

  it('サイズ 0 の画像を拒否する', async () => {
    await expect(
      seedArtwork({ imageKey: 'a.png', imageContentType: 'image/png', imageByteSize: 0 }),
    ).rejects.toSatisfy((error) => violatesConstraint(error, 'artworks_image_size_positive'));
  });
});

suite('非公開化と出品（不変条件を両方向から守る）', () => {
  type SeedStatus = 'draft' | 'scheduled' | 'active' | 'suspended' | 'ended';

  async function seedListing(artworkId: string, status: SeedStatus): Promise<string> {
    const id = randomUUID();
    await prisma.listing.create({
      data: {
        id,
        artworkId,
        priceAmount: 12000,
        priceCurrency: 'JPY',
        status,
        // scheduled は開始日時が必須（CHECK listings_scheduled_requires_start）。
        ...(status === 'scheduled' ? { startsAt: new Date('2026-09-01T00:00:00.000Z') } : {}),
      },
    });
    return id;
  }

  it('有効な出品が残ったまま作品を非公開にできない', async () => {
    // これが Phase 2 で開いていた穴。出品側のトリガだけでは
    // 「作る」ことしか防げず、「残る」ことを防げていなかった。
    const artworkId = await seedArtwork({ status: 'published' });
    await seedListing(artworkId, 'active');

    await expect(
      prisma.artwork.update({ where: { id: artworkId }, data: { status: 'archived' } }),
    ).rejects.toSatisfy((error) =>
      violatesConstraint(error, 'artworks_no_effective_listings_when_unpublished'),
    );
  });

  it('販売予定（scheduled）でも同じく拒否する', async () => {
    const artworkId = await seedArtwork({ status: 'published' });
    await seedListing(artworkId, 'scheduled');

    await expect(
      prisma.artwork.update({ where: { id: artworkId }, data: { status: 'archived' } }),
    ).rejects.toSatisfy((error) =>
      violatesConstraint(error, 'artworks_no_effective_listings_when_unpublished'),
    );
  });

  it('出品を終了してから非公開にすれば通る', async () => {
    const artworkId = await seedArtwork({ status: 'published' });
    const listingId = await seedListing(artworkId, 'active');

    await prisma.$transaction(async (tx) => {
      await tx.listing.update({ where: { id: listingId }, data: { status: 'ended' } });
      await tx.artwork.update({ where: { id: artworkId }, data: { status: 'archived' } });
    });

    const artwork = await prisma.artwork.findUniqueOrThrow({ where: { id: artworkId } });
    const listing = await prisma.listing.findUniqueOrThrow({ where: { id: listingId } });
    expect(artwork.status).toBe('archived');
    expect(listing.status).toBe('ended');
  });

  it('順序を逆にすると（作品を先に非公開）トランザクションごと失敗する', async () => {
    // 片方だけ適用されて終わらないことを確かめる。
    const artworkId = await seedArtwork({ status: 'published' });
    const listingId = await seedListing(artworkId, 'active');

    await expect(
      prisma.$transaction(async (tx) => {
        await tx.artwork.update({ where: { id: artworkId }, data: { status: 'archived' } });
        await tx.listing.update({ where: { id: listingId }, data: { status: 'ended' } });
      }),
    ).rejects.toSatisfy((error) =>
      violatesConstraint(error, 'artworks_no_effective_listings_when_unpublished'),
    );

    // 巻き戻っていること。作品も出品も元のまま。
    const artwork = await prisma.artwork.findUniqueOrThrow({ where: { id: artworkId } });
    const listing = await prisma.listing.findUniqueOrThrow({ where: { id: listingId } });
    expect(artwork.status).toBe('published');
    expect(listing.status).toBe('active');
  });

  it('下書き・終了済みの出品しかなければ、そのまま非公開にできる', async () => {
    const artworkId = await seedArtwork({ status: 'published' });
    await seedListing(artworkId, 'draft');
    await seedListing(artworkId, 'ended');

    const updated = await prisma.artwork.update({
      where: { id: artworkId },
      data: { status: 'archived' },
    });
    expect(updated.status).toBe('archived');
  });
});
