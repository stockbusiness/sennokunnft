import type { Artwork } from '../catalog/artwork';
import type { Listing } from '../catalog/listing';

/**
 * カタログの永続化境界。
 *
 * ここには interface だけを置く。実装は `@sengoku/database`。
 * ドメインは「どう保存されるか」を知らないので、
 * Prisma を別の手段に替えてもこの層は変わらない。
 */

export interface Page<T> {
  readonly items: readonly T[];
  /** 次ページの取得に使うカーソル。これ以上なければ `null`。 */
  readonly nextCursor: string | null;
}

export interface PageQuery {
  readonly limit: number;
  readonly cursor?: string | undefined;
}

export interface ArtworkRepository {
  findById(id: string): Promise<Artwork | null>;
  findBySlug(slug: string): Promise<Artwork | null>;
  /** 公開中の作品のみを返す。非公開を混ぜないことがこのメソッドの責務。 */
  listPublished(query: PageQuery): Promise<Page<Artwork>>;
  /** 状態を問わず一覧する（運営用）。 */
  listAll(query: PageQuery): Promise<Page<Artwork>>;
  create(artwork: Artwork): Promise<Artwork>;
  /** 在庫カウンタ以外の属性を更新する。カウンタは在庫操作専用の経路で扱う。 */
  update(artwork: Artwork): Promise<Artwork>;
}

export interface ListingRepository {
  findById(id: string): Promise<Listing | null>;
  /** 指定作品の出品を新しい順に返す。 */
  listByArtwork(artworkId: string): Promise<readonly Listing[]>;
  /** 公開カタログの詳細表示に使う、いま販売中の出品。 */
  findActiveByArtwork(artworkId: string): Promise<Listing | null>;
  create(listing: Listing): Promise<Listing>;
  update(listing: Listing): Promise<Listing>;
}
