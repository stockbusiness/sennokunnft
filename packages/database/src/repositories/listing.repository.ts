import type { Listing, ListingRepository, Page, PageQuery } from '@sengoku/domain';
import type { PrismaClient } from '../../generated/client';
import { decodeCursor, encodeCursor, toListing } from './mappers';

/** 1 回の取得件数の上限。呼び出し側が大きな値を渡しても、ここで頭打ちにする。 */
const MAX_PAGE_SIZE = 100;

/**
 * 出品リポジトリの Prisma 実装。
 *
 * 価格は最小通貨単位の整数のまま保存する。
 * 通貨コードは CHAR(3) なので、読み出し時に空白を落とす（mappers 側で処理）。
 */
export class PrismaListingRepository implements ListingRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findById(id: string): Promise<Listing | null> {
    const row = await this.prisma.listing.findUnique({ where: { id } });
    return row === null ? null : toListing(row);
  }

  /** 状態を問わず一覧する（運営用）。 */
  async listAll(query: PageQuery): Promise<Page<Listing>> {
    const limit = Math.min(Math.max(query.limit, 1), MAX_PAGE_SIZE);
    const cursor = decodeCursor(query.cursor);

    const rows = await this.prisma.listing.findMany({
      where:
        cursor === null
          ? {}
          : {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);
    return {
      items: page.map(toListing),
      nextCursor:
        hasMore && last !== undefined
          ? encodeCursor({ createdAt: last.createdAt, id: last.id })
          : null,
    };
  }

  /** 指定作品の出品。表示順が小さいものを先に返す。 */
  async listByArtwork(artworkId: string): Promise<readonly Listing[]> {
    const rows = await this.prisma.listing.findMany({
      where: { artworkId },
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
    });
    return rows.map(toListing);
  }

  /**
   * いま有効な出品を 1 件返す。
   *
   * `active` と `scheduled` を有効とみなす。DB の部分ユニーク索引
   * （listings_one_effective_per_artwork）により同時に 1 件しか存在しない。
   */
  async findActiveByArtwork(artworkId: string): Promise<Listing | null> {
    const row = await this.prisma.listing.findFirst({
      where: { artworkId, status: { in: ['active', 'scheduled'] } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return row === null ? null : toListing(row);
  }

  async create(listing: Listing): Promise<Listing> {
    const row = await this.prisma.listing.create({
      data: {
        id: listing.id,
        artworkId: listing.artworkId,
        priceAmount: listing.price.amountMinor,
        priceCurrency: listing.price.currency,
        maxQuantityPerOrder: listing.maxQuantityPerOrder,
        status: listing.status,
        startsAt: listing.startsAt,
        endsAt: listing.endsAt,
        displayOrder: listing.displayOrder,
      },
    });
    return toListing(row);
  }

  async update(listing: Listing): Promise<Listing> {
    const row = await this.prisma.listing.update({
      where: { id: listing.id },
      data: {
        priceAmount: listing.price.amountMinor,
        priceCurrency: listing.price.currency,
        maxQuantityPerOrder: listing.maxQuantityPerOrder,
        status: listing.status,
        startsAt: listing.startsAt,
        endsAt: listing.endsAt,
        displayOrder: listing.displayOrder,
      },
    });
    return toListing(row);
  }
}
