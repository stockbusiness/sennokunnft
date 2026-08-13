import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  AdminArtwork,
  AdminArtworkListResponse,
  AdminListing,
  CreateArtworkRequest,
  CreateListingRequest,
  UpdateArtworkRequest,
  UpdateListingRequest,
} from '@sengoku/contracts';
import {
  activateListing,
  archiveArtwork,
  availableSupply,
  closeListing,
  createArtworkDraft,
  createListing,
  pauseListing,
  publishArtwork,
  updateArtwork,
  updateListing,
  type Artwork,
  type ArtworkRepository,
  type DomainError,
  type IdGeneratorPort,
  type Listing,
  type ListingRepository,
  type Result,
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
  ) {}

  async listArtworks(query: { limit: number; cursor?: string }): Promise<AdminArtworkListResponse> {
    const page = await this.artworks.listAll(query);
    return { items: page.items.map(toAdminArtwork), nextCursor: page.nextCursor };
  }

  async getArtwork(id: string): Promise<AdminArtwork> {
    const artwork = await this.artworks.findById(id);
    if (artwork === null) {
      throw new NotFoundException();
    }
    return toAdminArtwork(artwork);
  }

  async createArtwork(request: CreateArtworkRequest): Promise<AdminArtwork> {
    const draft = unwrapDomain(
      createArtworkDraft({
        id: this.ids.generate(),
        slug: request.slug,
        title: request.title,
        description: request.description,
        imageKey: request.imageKey ?? null,
        maxSupply: request.maxSupply,
      }),
    );
    const saved = await this.artworks.create(draft);
    return toAdminArtwork(saved);
  }

  async updateArtwork(id: string, request: UpdateArtworkRequest): Promise<AdminArtwork> {
    const artwork = await this.loadArtwork(id);
    const updated = unwrapDomain(updateArtwork(artwork, request));
    const saved = await this.artworks.update(updated);
    return toAdminArtwork(saved);
  }

  async publishArtwork(id: string): Promise<AdminArtwork> {
    const artwork = await this.loadArtwork(id);
    const published = unwrapDomain(publishArtwork(artwork));
    const saved = await this.artworks.update(published);
    return toAdminArtwork(saved);
  }

  async archiveArtwork(id: string): Promise<AdminArtwork> {
    const artwork = await this.loadArtwork(id);
    const archived = unwrapDomain(archiveArtwork(artwork));
    const saved = await this.artworks.update(archived);
    return toAdminArtwork(saved);
  }

  async listListings(artworkId: string): Promise<AdminListing[]> {
    await this.loadArtwork(artworkId);
    const listings = await this.listings.listByArtwork(artworkId);
    return listings.map(toAdminListing);
  }

  async createListing(request: CreateListingRequest): Promise<AdminListing> {
    // 存在しない作品に出品を作らせない。
    await this.loadArtwork(request.artworkId);

    const draft = unwrapDomain(
      createListing({
        id: this.ids.generate(),
        artworkId: request.artworkId,
        priceAmount: request.priceAmount,
        priceCurrency: request.priceCurrency,
        maxQuantityPerOrder: request.maxQuantityPerOrder,
        startsAt: toDate(request.startsAt),
        endsAt: toDate(request.endsAt),
      }),
    );
    const saved = await this.listings.create(draft);
    return toAdminListing(saved);
  }

  async updateListing(id: string, request: UpdateListingRequest): Promise<AdminListing> {
    const listing = await this.loadListing(id);
    const updated = unwrapDomain(
      updateListing(listing, {
        priceAmount: request.priceAmount,
        priceCurrency: request.priceCurrency,
        maxQuantityPerOrder: request.maxQuantityPerOrder,
        startsAt: request.startsAt === undefined ? undefined : toDate(request.startsAt),
        endsAt: request.endsAt === undefined ? undefined : toDate(request.endsAt),
      }),
    );
    const saved = await this.listings.update(updated);
    return toAdminListing(saved);
  }

  /** 販売を開始する。作品が公開されていなければドメイン側が拒否する。 */
  async activateListing(id: string): Promise<AdminListing> {
    const listing = await this.loadListing(id);
    const artwork = await this.loadArtwork(listing.artworkId);
    const activated = unwrapDomain(activateListing(listing, artwork));
    const saved = await this.listings.update(activated);
    return toAdminListing(saved);
  }

  async pauseListing(id: string): Promise<AdminListing> {
    const listing = await this.loadListing(id);
    const paused = unwrapDomain(pauseListing(listing));
    const saved = await this.listings.update(paused);
    return toAdminListing(saved);
  }

  async closeListing(id: string): Promise<AdminListing> {
    const listing = await this.loadListing(id);
    const closed = unwrapDomain(closeListing(listing));
    const saved = await this.listings.update(closed);
    return toAdminListing(saved);
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

function toAdminArtwork(artwork: Artwork): AdminArtwork {
  return {
    id: artwork.id,
    slug: artwork.slug,
    title: artwork.title,
    description: artwork.description,
    imageKey: artwork.imageKey,
    maxSupply: artwork.maxSupply,
    reservedCount: artwork.reservedCount,
    issuedCount: artwork.issuedCount,
    availableSupply: availableSupply(artwork),
    status: artwork.status,
  };
}

function toAdminListing(listing: Listing): AdminListing {
  return {
    id: listing.id,
    artworkId: listing.artworkId,
    price: { amount: listing.price.amountMinor, currency: listing.price.currency },
    maxQuantityPerOrder: listing.maxQuantityPerOrder,
    status: listing.status,
    startsAt: listing.startsAt?.toISOString() ?? null,
    endsAt: listing.endsAt?.toISOString() ?? null,
  };
}
