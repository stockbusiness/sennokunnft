import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  CreateArtworkRequest,
  CreateListingRequest,
  CreatorArtwork,
  CreatorListing,
  UpdateArtworkRequest,
  UpdateListingRequest,
} from '@sengoku/contracts';
import type { Actor } from '@sengoku/auth';
import { isAllowed } from '@sengoku/auth';
import type { Artwork, ArtworkRepository, ListingRepository } from '@sengoku/domain';
import { AdminCatalogService } from './admin-catalog.service';

/**
 * 出品者が**自分の**作品に対して行う操作（`UD-102` 決定変更 2026-08-18）。
 *
 * ⚠️ **判断も業務規則もここに書かない。** 作品の状態遷移は
 * `AdminCatalogService` を通して `@sengoku/domain` が行う。
 * ここが足すのは **「その作品はあなたのものか」の 1 点だけ**。
 *
 * 同じ規則を 2 か所に書くと、片方だけ直したときに
 * 「運営からは通るが出品者からは通らない」ようなずれが生まれる。
 *
 * ⚠️ **管理API（`/api/v1/admin/**`）を出品者に開放しない。**
 * あちらは `operator` 一括保護という性質そのものが守りになっている。
 * 「所有者なら通す」に変えると、どこか一箇所の書き漏れが
 * 他人のデータへの到達に変わる。入口を分けたのはそのため。
 */
@Injectable()
export class CreatorCatalogService {
  constructor(
    private readonly admin: AdminCatalogService,
    private readonly artworks: ArtworkRepository,
    private readonly listings: ListingRepository,
  ) {}

  // --- 作品 ----------------------------------------------------------------

  async listMyArtworks(
    actor: Actor,
    query: { limit: number; cursor?: string },
  ): Promise<{ items: CreatorArtwork[]; nextCursor: string | null }> {
    const accountId = requireAccountId(actor);
    // ⚠️ 全件を取ってから絞り込まない。1ページ目が他人の作品で埋まる。
    const page = await this.artworks.listByCreator(accountId, {
      limit: query.limit,
      cursor: query.cursor,
    });
    const items: CreatorArtwork[] = [];
    for (const artwork of page.items) {
      items.push(await this.admin.getArtwork(artwork.id));
    }
    return { items, nextCursor: page.nextCursor };
  }

  async getMyArtwork(actor: Actor, id: string): Promise<CreatorArtwork> {
    await this.assertOwnsArtwork(actor, id);
    return this.admin.getArtwork(id);
  }

  createArtwork(actor: Actor, request: CreateArtworkRequest): Promise<CreatorArtwork> {
    // 作った人がそのまま持ち主になる（`AdminCatalogService.createArtwork`）。
    // ここで持ち主を指定させない。指定できるなら他人名義で作れてしまう。
    return this.admin.createArtwork(request, requireAccountId(actor));
  }

  async updateArtwork(
    actor: Actor,
    id: string,
    request: UpdateArtworkRequest,
  ): Promise<CreatorArtwork> {
    await this.assertOwnsArtwork(actor, id);
    return this.admin.updateArtwork(id, request, requireAccountId(actor));
  }

  async publishArtwork(actor: Actor, id: string): Promise<CreatorArtwork> {
    await this.assertOwnsArtwork(actor, id);
    return this.admin.publishArtwork(id, requireAccountId(actor));
  }

  async archiveArtwork(actor: Actor, id: string): Promise<CreatorArtwork> {
    await this.assertOwnsArtwork(actor, id);
    return this.admin.archiveArtwork(id, requireAccountId(actor));
  }

  // --- 出品 ----------------------------------------------------------------

  async listMyListings(
    actor: Actor,
    artworkId: string,
  ): Promise<{ items: CreatorListing[]; nextCursor: string | null }> {
    await this.assertOwnsArtwork(actor, artworkId);
    return this.admin.listListings({ limit: 100, artworkId });
  }

  async createListing(actor: Actor, request: CreateListingRequest): Promise<CreatorListing> {
    // ⚠️ 出品の持ち主は**作品の**持ち主。出品そのものは持ち主を持たない。
    await this.assertOwnsArtwork(actor, request.artworkId);
    return this.admin.createListing(request, requireAccountId(actor));
  }

  async updateListing(
    actor: Actor,
    id: string,
    request: UpdateListingRequest,
  ): Promise<CreatorListing> {
    await this.assertOwnsListing(actor, id);
    return this.admin.updateListing(id, request, requireAccountId(actor));
  }

  async activateListing(actor: Actor, id: string): Promise<CreatorListing> {
    await this.assertOwnsListing(actor, id);
    return this.admin.activateListing(id, requireAccountId(actor));
  }

  async suspendListing(actor: Actor, id: string): Promise<CreatorListing> {
    await this.assertOwnsListing(actor, id);
    return this.admin.suspendListing(id, requireAccountId(actor));
  }

  async endListing(actor: Actor, id: string): Promise<CreatorListing> {
    await this.assertOwnsListing(actor, id);
    return this.admin.endListing(id, requireAccountId(actor));
  }

  // --- 所有権 --------------------------------------------------------------

  /**
   * その作品が自分のものであることを確かめる。
   *
   * ⚠️ **他人の作品には 403 ではなく 404 を返す。**
   * 403 は「在るが触れない」と答えてしまう。IDを総当たりすれば、
   * どのIDが実在するかを数えられる。まだ公開していない下書きの存在まで
   * 漏れるので、区別しない。
   *
   * ⚠️ **運営（`operator`）は通る。** 出品前の審査を行わない代わりに、
   * 問題のある出品を事後に止める経路が要るため（`artwork.manage` による免除）。
   */
  async assertOwnsArtwork(actor: Actor, artworkId: string): Promise<Artwork> {
    const artwork = await this.artworks.findById(artworkId);
    if (artwork === null) {
      throw new NotFoundException();
    }
    if (!isAllowed(actor, 'artwork.manage_own', { ownerAccountId: artwork.creatorAccountId })) {
      throw new NotFoundException();
    }
    return artwork;
  }

  private async assertOwnsListing(actor: Actor, listingId: string): Promise<void> {
    const listing = await this.listings.findById(listingId);
    if (listing === null) {
      throw new NotFoundException();
    }
    const artwork = await this.artworks.findById(listing.artworkId);
    if (artwork === null) {
      throw new NotFoundException();
    }
    if (!isAllowed(actor, 'listing.manage_own', { ownerAccountId: artwork.creatorAccountId })) {
      throw new NotFoundException();
    }
  }
}

/**
 * 認証済みであることは `AuthGuard` が保証している。
 * ここに来て `null` なら配線の誤りなので、握りつぶさず落とす。
 */
function requireAccountId(actor: Actor): string {
  if (actor.accountId === null) {
    throw new NotFoundException();
  }
  return actor.accountId;
}
