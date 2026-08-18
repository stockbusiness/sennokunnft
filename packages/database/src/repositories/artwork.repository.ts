import type { Artwork, ArtworkRepository, Listing, Page, PageQuery } from '@sengoku/domain';
import type { PrismaClient } from '../../generated/client';
import { decodeCursor, encodeCursor, toArtwork } from './mappers';

/** 1 回の取得件数の上限。呼び出し側が大きな値を渡しても、ここで頭打ちにする。 */
const MAX_PAGE_SIZE = 100;

/**
 * 作品リポジトリの Prisma 実装。
 *
 * ⚠️ **在庫カウンタ（reservedCount / issuedCount）をここでは更新しない。**
 * カウンタの更新は行ロックを伴う在庫操作専用の経路で行う（Phase 3）。
 * 一般の更新経路から触れるようにすると、ロックを取らない更新が紛れ込み、
 * オーバーセルの原因になる。
 */
export class PrismaArtworkRepository implements ArtworkRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findById(id: string): Promise<Artwork | null> {
    const row = await this.prisma.artwork.findUnique({ where: { id } });
    return row === null ? null : toArtwork(row);
  }

  async findBySlug(slug: string): Promise<Artwork | null> {
    const row = await this.prisma.artwork.findUnique({ where: { slug } });
    return row === null ? null : toArtwork(row);
  }

  /** 公開中の作品のみ。非公開を混ぜないことがこのメソッドの責務。 */
  listPublished(query: PageQuery): Promise<Page<Artwork>> {
    return this.list(query, { status: 'published' });
  }

  listAll(query: PageQuery): Promise<Page<Artwork>> {
    return this.list(query, {});
  }

  /** 指定した出品者の作品のみ。絞り込みは DB に任せる（ポートの注記を参照）。 */
  listByCreator(creatorAccountId: string, query: PageQuery): Promise<Page<Artwork>> {
    return this.list(query, { creatorAccountId });
  }

  async create(artwork: Artwork): Promise<Artwork> {
    const row = await this.prisma.artwork.create({
      data: {
        id: artwork.id,
        creatorAccountId: artwork.creatorAccountId,
        slug: artwork.slug,
        title: artwork.title,
        description: artwork.description,
        imageKey: artwork.imageKey,
        imageContentType: artwork.imageContentType,
        imageByteSize: artwork.imageByteSize,
        imageHash: artwork.imageHash,
        maxSupply: artwork.maxSupply,
        reservedCount: artwork.reservedCount,
        issuedCount: artwork.issuedCount,
        status: artwork.status,
      },
    });
    return toArtwork(row);
  }

  async update(artwork: Artwork): Promise<Artwork> {
    const row = await this.prisma.artwork.update({
      where: { id: artwork.id },
      // 在庫カウンタを意図的に含めていない（上のクラスコメント参照）。
      data: {
        slug: artwork.slug,
        title: artwork.title,
        description: artwork.description,
        imageKey: artwork.imageKey,
        imageContentType: artwork.imageContentType,
        imageByteSize: artwork.imageByteSize,
        imageHash: artwork.imageHash,
        maxSupply: artwork.maxSupply,
        status: artwork.status,
      },
    });
    return toArtwork(row);
  }

  /**
   * 作品を非公開にし、有効な出品を終了する。**1 トランザクションで行う。**
   *
   * ⚠️ **出品を先に終了させてから作品を更新する。順序に意味がある。**
   * 作品側のトリガは「非公開なら有効な出品が無いこと」を確かめるため、
   * 逆順にすると自分自身の更新でトリガに弾かれる。
   */
  async archiveWithListings(artwork: Artwork, endedListings: readonly Listing[]): Promise<Artwork> {
    return this.prisma.$transaction(async (tx) => {
      for (const listing of endedListings) {
        await tx.listing.update({
          where: { id: listing.id },
          data: { status: listing.status },
        });
      }
      const row = await tx.artwork.update({
        where: { id: artwork.id },
        data: { status: artwork.status },
      });
      return toArtwork(row);
    });
  }

  /**
   * 作品と出品を完全に消す。**1 トランザクションで行う。**
   *
   * ⚠️ **出品を先に消す。** 作品を先に消そうとすると、出品からの
   * 外部キーに弾かれる。
   *
   * ⚠️ **外部キー違反を握りつぶさない。** 注文明細・受取権から
   * 参照されていれば PostgreSQL が拒否する。それが最後の砦なので、
   * ここで `catch` して「消えたことにする」ようなことはしない。
   */
  async deleteWithListings(artworkId: string, listingIds: readonly string[]): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      if (listingIds.length > 0) {
        // 作品に紐づく出品だけを消す。ID の指定漏れがあっても
        // 他作品の出品まで巻き込まないよう、作品IDでも絞る。
        await tx.listing.deleteMany({ where: { id: { in: [...listingIds] }, artworkId } });
      }
      await tx.artwork.delete({ where: { id: artworkId } });
    });
  }

  /** キーセットページング。新しい順に返す。 */
  private async list(
    query: PageQuery,
    where: { status?: 'published'; creatorAccountId?: string },
  ): Promise<Page<Artwork>> {
    const limit = Math.min(Math.max(query.limit, 1), MAX_PAGE_SIZE);
    const cursor = decodeCursor(query.cursor);

    const rows = await this.prisma.artwork.findMany({
      where: {
        ...where,
        // (createdAt, id) の複合キーで「カーソルより後」を表す。
        // createdAt が同着の行を取りこぼさないよう id で分ける。
        ...(cursor === null
          ? {}
          : {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      // 次ページの有無を知るために 1 件多く取る。
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);

    return {
      items: page.map(toArtwork),
      nextCursor:
        hasMore && last !== undefined
          ? encodeCursor({ createdAt: last.createdAt, id: last.id })
          : null,
    };
  }
}
