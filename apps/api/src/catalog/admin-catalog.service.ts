import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  AdminArtwork,
  AdminArtworkListResponse,
  AdminListing,
  AdminListingListResponse,
  CreateArtworkRequest,
  CreateListingRequest,
  UpdateArtworkRequest,
  UpdateListingRequest,
} from '@sengoku/contracts';
import {
  activateListing,
  archiveArtwork,
  availableSupply,
  createArtworkDraft,
  createListing,
  endListing,
  publishArtwork,
  resolveDisplayState,
  suspendListing,
  updateArtwork,
  updateListing,
  type Artwork,
  type ArtworkRepository,
  type AuditLogPort,
  type ClockPort,
  type DomainError,
  type IdGeneratorPort,
  type Listing,
  type ListingRepository,
  type Result,
  type StoragePort,
} from '@sengoku/domain';
import { DomainErrorException } from '../common/domain-error.filter';

/**
 * 運営によるカタログ操作。
 *
 * このクラスは**判断をしない**。判断はすべて `@sengoku/domain` の
 * 純粋関数が行い、ここはリポジトリとの往復を組み立てるだけ。
 * 業務規則をここに書き始めると、フレームワーク層に業務判断が滲み出す。
 */
@Injectable()
export class AdminCatalogService {
  constructor(
    private readonly artworks: ArtworkRepository,
    private readonly listings: ListingRepository,
    private readonly ids: IdGeneratorPort,
    private readonly clock: ClockPort,
    private readonly storage: StoragePort,
    private readonly audit: AuditLogPort,
  ) {}

  async listArtworks(query: { limit: number; cursor?: string }): Promise<AdminArtworkListResponse> {
    const page = await this.artworks.listAll(query);
    return {
      items: page.items.map((artwork) => this.toAdminArtwork(artwork)),
      nextCursor: page.nextCursor,
    };
  }

  async getArtwork(id: string): Promise<AdminArtwork> {
    return this.toAdminArtwork(await this.loadArtwork(id));
  }

  async createArtwork(request: CreateArtworkRequest, actorId: string): Promise<AdminArtwork> {
    const draft = unwrapDomain(
      createArtworkDraft({
        id: this.ids.generate(),
        slug: request.slug,
        title: request.title,
        description: request.description,
        maxSupply: request.maxSupply,
      }),
    );
    const saved = await this.artworks.create(draft);
    await this.audit.record({
      actorAccountId: actorId,
      action: 'artwork.create',
      targetType: 'artwork',
      targetId: saved.id,
      summary: { slug: saved.slug, maxSupply: saved.maxSupply },
    });
    return this.toAdminArtwork(saved);
  }

  async updateArtwork(
    id: string,
    request: UpdateArtworkRequest,
    actorId: string,
  ): Promise<AdminArtwork> {
    const artwork = await this.loadArtwork(id);
    const updated = unwrapDomain(updateArtwork(artwork, request));
    const saved = await this.artworks.update(updated);
    await this.audit.record({
      actorAccountId: actorId,
      action: 'artwork.update',
      targetType: 'artwork',
      targetId: saved.id,
      // 変更後の値ではなく「どの項目を変えたか」を残す。
      summary: { changed: Object.keys(request) },
    });
    return this.toAdminArtwork(saved);
  }

  async publishArtwork(id: string, actorId: string): Promise<AdminArtwork> {
    const artwork = await this.loadArtwork(id);
    const published = unwrapDomain(publishArtwork(artwork));
    const saved = await this.artworks.update(published);
    await this.audit.record({
      actorAccountId: actorId,
      action: 'artwork.publish',
      targetType: 'artwork',
      targetId: saved.id,
      summary: { slug: saved.slug },
    });
    return this.toAdminArtwork(saved);
  }

  async archiveArtwork(id: string, actorId: string): Promise<AdminArtwork> {
    const artwork = await this.loadArtwork(id);
    const archived = unwrapDomain(archiveArtwork(artwork));
    const saved = await this.artworks.update(archived);
    await this.audit.record({
      actorAccountId: actorId,
      action: 'artwork.archive',
      targetType: 'artwork',
      targetId: saved.id,
      summary: { slug: saved.slug },
    });
    return this.toAdminArtwork(saved);
  }

  /** 出品の一覧。作品で絞り込める。 */
  async listListings(query: {
    limit: number;
    cursor?: string;
    artworkId?: string;
  }): Promise<AdminListingListResponse> {
    if (query.artworkId !== undefined) {
      await this.loadArtwork(query.artworkId);
      const listings = await this.listings.listByArtwork(query.artworkId);
      const items = await this.toAdminListings(listings.slice(0, query.limit));
      return { items, nextCursor: null };
    }

    const page = await this.listings.listAll(query);
    return { items: await this.toAdminListings(page.items), nextCursor: page.nextCursor };
  }

  async getListing(id: string): Promise<AdminListing> {
    const listing = await this.loadListing(id);
    return this.toAdminListing(listing, await this.loadArtwork(listing.artworkId));
  }

  async createListing(request: CreateListingRequest, actorId: string): Promise<AdminListing> {
    // 存在しない作品に出品を作らせない。
    const artwork = await this.loadArtwork(request.artworkId);

    const draft = unwrapDomain(
      createListing({
        id: this.ids.generate(),
        artworkId: request.artworkId,
        priceAmount: request.priceAmount,
        priceCurrency: request.priceCurrency,
        maxQuantityPerOrder: request.maxQuantityPerOrder,
        startsAt: toDate(request.startsAt),
        endsAt: toDate(request.endsAt),
        displayOrder: request.displayOrder,
      }),
    );
    const saved = await this.listings.create(draft);
    await this.audit.record({
      actorAccountId: actorId,
      action: 'listing.create',
      targetType: 'listing',
      targetId: saved.id,
      summary: { artworkId: saved.artworkId, priceAmount: saved.price.amountMinor },
    });
    return this.toAdminListing(saved, artwork);
  }

  async updateListing(
    id: string,
    request: UpdateListingRequest,
    actorId: string,
  ): Promise<AdminListing> {
    const listing = await this.loadListing(id);
    const updated = unwrapDomain(
      updateListing(listing, {
        priceAmount: request.priceAmount,
        priceCurrency: request.priceCurrency,
        maxQuantityPerOrder: request.maxQuantityPerOrder,
        startsAt: request.startsAt === undefined ? undefined : toDate(request.startsAt),
        endsAt: request.endsAt === undefined ? undefined : toDate(request.endsAt),
        displayOrder: request.displayOrder,
      }),
    );
    const saved = await this.listings.update(updated);
    await this.audit.record({
      actorAccountId: actorId,
      action: 'listing.update',
      targetType: 'listing',
      targetId: saved.id,
      summary: { changed: Object.keys(request) },
    });
    return this.toAdminListing(saved, await this.loadArtwork(saved.artworkId));
  }

  /** 販売を開始する。作品が公開されていなければドメイン側が拒否する。 */
  async activateListing(id: string, actorId: string): Promise<AdminListing> {
    const listing = await this.loadListing(id);
    const artwork = await this.loadArtwork(listing.artworkId);
    const activated = unwrapDomain(activateListing(listing, artwork, this.clock.now()));
    const saved = await this.listings.update(activated);
    await this.audit.record({
      actorAccountId: actorId,
      action: 'listing.activate',
      targetType: 'listing',
      targetId: saved.id,
      summary: { status: saved.status },
    });
    return this.toAdminListing(saved, artwork);
  }

  async suspendListing(id: string, actorId: string): Promise<AdminListing> {
    const listing = await this.loadListing(id);
    const suspended = unwrapDomain(suspendListing(listing));
    const saved = await this.listings.update(suspended);
    await this.audit.record({
      actorAccountId: actorId,
      action: 'listing.suspend',
      targetType: 'listing',
      targetId: saved.id,
      summary: {},
    });
    return this.toAdminListing(saved, await this.loadArtwork(saved.artworkId));
  }

  async endListing(id: string, actorId: string): Promise<AdminListing> {
    const listing = await this.loadListing(id);
    const ended = unwrapDomain(endListing(listing));
    const saved = await this.listings.update(ended);
    await this.audit.record({
      actorAccountId: actorId,
      action: 'listing.end',
      targetType: 'listing',
      targetId: saved.id,
      summary: {},
    });
    return this.toAdminListing(saved, await this.loadArtwork(saved.artworkId));
  }

  private async loadArtwork(id: string): Promise<Artwork> {
    const artwork = await this.artworks.findById(id);
    if (artwork === null) {
      throw new NotFoundException();
    }
    return artwork;
  }

  private async loadListing(id: string): Promise<Listing> {
    const listing = await this.listings.findById(id);
    if (listing === null) {
      throw new NotFoundException();
    }
    return listing;
  }

  private async toAdminListings(listings: readonly Listing[]): Promise<AdminListing[]> {
    const result: AdminListing[] = [];
    for (const listing of listings) {
      const artwork = await this.artworks.findById(listing.artworkId);
      if (artwork === null) {
        continue;
      }
      result.push(this.toAdminListing(listing, artwork));
    }
    return result;
  }

  private toAdminArtwork(artwork: Artwork): AdminArtwork {
    return {
      id: artwork.id,
      slug: artwork.slug,
      title: artwork.title,
      description: artwork.description,
      imageKey: artwork.imageKey,
      // 公開URLは保存せず、キーから実行時に解決する。
      imageUrl: artwork.imageKey === null ? null : this.storage.publicUrl(artwork.imageKey),
      imageContentType: artwork.imageContentType,
      imageByteSize: artwork.imageByteSize,
      maxSupply: artwork.maxSupply,
      reservedCount: artwork.reservedCount,
      issuedCount: artwork.issuedCount,
      availableSupply: availableSupply(artwork),
      status: artwork.status,
    };
  }

  private toAdminListing(listing: Listing, artwork: Artwork): AdminListing {
    return {
      id: listing.id,
      artworkId: listing.artworkId,
      price: { amount: listing.price.amountMinor, currency: listing.price.currency },
      maxQuantityPerOrder: listing.maxQuantityPerOrder,
      status: listing.status,
      displayOrder: listing.displayOrder,
      // 運営画面でも「いま利用者にどう見えているか」を同じ判定で出す。
      displayState: resolveDisplayState({ listing, artwork, now: this.clock.now() }),
      startsAt: listing.startsAt?.toISOString() ?? null,
      endsAt: listing.endsAt?.toISOString() ?? null,
    };
  }
}

/** ドメインの Result を、HTTP 境界へ運べる例外に変える。 */
function unwrapDomain<T>(result: Result<T, DomainError>): T {
  if (!result.ok) {
    throw new DomainErrorException(result.error.code);
  }
  return result.value;
}

function toDate(value: string | null | undefined): Date | null {
  return value === null || value === undefined ? null : new Date(value);
}
