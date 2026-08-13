import type { Listing, ListingRepository } from '@sengoku/domain';
import type { PrismaClient } from '../../generated/client';
import { toListing } from './mappers';

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

  async listByArtwork(artworkId: string): Promise<readonly Listing[]> {
    const rows = await this.prisma.listing.findMany({
      where: { artworkId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return rows.map(toListing);
  }

  /**
   * いま販売中の出品を 1 件返す。
   *
   * 同じ作品に `active` な出品が複数あるのは運用上の誤りだが、
   * DB では禁じていない（部分ユニーク制約を入れると価格改定の手順が硬直するため）。
   * ここでは新しいものを優先して返し、古い出品が表示され続ける事故を避ける。
   */
  async findActiveByArtwork(artworkId: string): Promise<Listing | null> {
    const row = await this.prisma.listing.findFirst({
      where: { artworkId, status: 'active' },
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
      },
    });
    return toListing(row);
  }
}
