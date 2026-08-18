import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../../generated/client';
import { PrismaArtworkRepository } from '../../src/repositories/artwork.repository';
import { createTestClient, integrationTestsAvailable, resetDatabase } from '../helpers/database';

/**
 * 作品の削除を、実 PostgreSQL に対して確かめる（`UD-113` 仮決定）。
 *
 * ⚠️ **ここを Fake で済ませない。**
 * 確かめたいのは「売れた作品は、アプリ側の判断をすり抜けても消えない」ことで、
 * それを保証しているのは外部キーの `RESTRICT`。
 * メモリ実装で確かめても意味がない。
 */
const enabled = integrationTestsAvailable();
const suite = enabled ? describe : describe.skip;

let prisma: PrismaClient;
let repo: PrismaArtworkRepository;

beforeAll(async () => {
  if (!enabled) return;
  prisma = createTestClient();
  await prisma.$connect();
  repo = new PrismaArtworkRepository(prisma);
});

afterAll(async () => {
  if (!enabled) return;
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!enabled) return;
  await resetDatabase(prisma);
});

/** 作品を 1 件だけ作る。持ち主のアカウントも一緒に作る。 */
async function seedArtwork(): Promise<{ artworkId: string; accountId: string }> {
  const accountId = randomUUID();
  await prisma.account.create({
    data: { id: accountId, authProvider: 'fake', authSubject: accountId },
  });
  const artwork = await prisma.artwork.create({
    data: {
      creatorAccountId: accountId,
      slug: `artwork-${randomUUID()}`,
      title: '消す試験の作品',
      description: '',
      maxSupply: 10,
      status: 'draft',
    },
  });
  return { artworkId: artwork.id, accountId };
}

suite('作品の削除', () => {
  it('作品と出品がまとめて消える', async () => {
    const { artworkId } = await seedArtwork();
    const listing = await prisma.listing.create({
      data: { artworkId, priceAmount: 1000, priceCurrency: 'JPY' },
    });

    await repo.deleteWithListings(artworkId, [listing.id]);

    expect(await prisma.artwork.findUnique({ where: { id: artworkId } })).toBeNull();
    expect(await prisma.listing.findUnique({ where: { id: listing.id } })).toBeNull();
  });

  it('他の作品の出品を巻き込まない', async () => {
    const first = await seedArtwork();
    const second = await seedArtwork();
    const survivor = await prisma.listing.create({
      data: { artworkId: second.artworkId, priceAmount: 1000, priceCurrency: 'JPY' },
    });

    // ⚠️ 呼び出し側が他作品の出品IDを混ぜてきた場合。
    //    作品IDでも絞っているので、混ざったものは消えない。
    await repo.deleteWithListings(first.artworkId, [survivor.id]);

    expect(await prisma.listing.findUnique({ where: { id: survivor.id } })).not.toBeNull();
  });

  it('注文明細から参照されている作品は、DB が消させない', async () => {
    // ⚠️ これが最後の砦。アプリ側の判定に穴があっても、
    //    買われた作品の行が消えないことを外部キーが保証する。
    const { artworkId, accountId } = await seedArtwork();
    const listing = await prisma.listing.create({
      data: { artworkId, priceAmount: 1000, priceCurrency: 'JPY' },
    });
    const order = await prisma.order.create({
      data: {
        accountId,
        totalAmount: 1000,
        totalCurrency: 'JPY',
        idempotencyKey: randomUUID(),
      },
    });
    await prisma.orderLine.create({
      data: {
        orderId: order.id,
        listingId: listing.id,
        artworkId,
        artworkTitleSnapshot: '消す試験の作品',
        unitPriceAmount: 1000,
        unitPriceCurrency: 'JPY',
        quantity: 1,
      },
    });

    await expect(repo.deleteWithListings(artworkId, [listing.id])).rejects.toThrow();

    // 失敗したときに出品だけ消えていない（1 トランザクションで巻き戻る）。
    expect(await prisma.artwork.findUnique({ where: { id: artworkId } })).not.toBeNull();
    expect(await prisma.listing.findUnique({ where: { id: listing.id } })).not.toBeNull();
  });
});
