import { Injectable } from '@nestjs/common';
import type {
  ArtworkDetail,
  ArtworkListResponse,
  ArtworkSummary,
  PublicListing,
  PublicListingListResponse,
} from '@sengoku/contracts';
import {
  availableSupply,
  evaluatePurchasability,
  resolveDisplayState,
  type Artwork,
  type ArtworkRepository,
  type ClockPort,
  type Listing,
  type ListingRepository,
  type StoragePort,
} from '@sengoku/domain';

/**
 * 公開カタログの読み取り。
 *
 * ⚠️ **非公開の作品を返さない**ことがこのクラスの中心的な責務。
 * リポジトリの `listPublished` / 状態チェックの両方で担保している。
 */
@Injectable()
export class CatalogService {
  constructor(
    private readonly artworks: ArtworkRepository,
    private readonly listings: ListingRepository,
    private readonly clock: ClockPort,
    /**
     * 画像URLの解決に使う。
     *
     * ⚠️ **管理側（`AdminCatalogService`）と同じポートを使う。**
     * 公開側だけ別の組み立て方にすると、保存先を差し替えたときに
     * 片方だけ古い形の URL を返し続ける。
     */
    private readonly storage: StoragePort,
  ) {}

  async listPublished(query: { limit: number; cursor?: string }): Promise<ArtworkListResponse> {
    const page = await this.artworks.listPublished(query);

    // 一覧の各作品について販売中の出品を引く。
    // N+1 になるが、1 ページ最大 100 件で、Phase 3 以降に必要なら
    // まとめ取得へ差し替える（先に複雑にしない）。
    const items = await Promise.all(
      page.items.map(async (artwork) => {
        const listing = await this.listings.findActiveByArtwork(artwork.id);
        return this.toSummary(artwork, listing);
      }),
    );

    return { items, nextCursor: page.nextCursor };
  }

  /**
   * 作品詳細。
   *
   * 見つからない場合と非公開の場合を**同じ `null`** で返す。
   * 呼び出し側が 404 に写すことで、非公開作品の存在を外部から観測できなくする。
   */
  async findPublishedBySlug(slug: string): Promise<ArtworkDetail | null> {
    const artwork = await this.artworks.findBySlug(slug);
    if (artwork === null || artwork.status !== 'published') {
      return null;
    }

    const active = await this.listings.findActiveByArtwork(artwork.id);

    // 有効な出品が無いときは、直近の出品を見て「終了した」のか
    // 「そもそも売っていない」のかを区別する。
    // どちらも「購入できません」で済ませると、
    // 買えるはずだったのか判断できず、利用者は問い合わせるしかなくなる。
    const listing = active ?? (await this.findLatestListing(artwork.id));
    const summary = this.toSummary(artwork, active);

    return {
      ...summary,
      // 表示状態は「終了」を含めて判定するため、直近の出品を使う。
      displayState:
        listing === null
          ? 'not_available'
          : resolveDisplayState({ listing, artwork, now: this.clock.now() }),
      description: artwork.description,
      // 申し込み先として渡してよいのは、いま有効な出品だけ。
      listingId: active?.id ?? null,
      maxQuantityPerOrder: active?.maxQuantityPerOrder ?? null,
      unavailableReason: this.resolveUnavailableReason(artwork, listing),
    };
  }

  /** 直近の出品。終了済みも含める（表示の区別に使う）。 */
  private async findLatestListing(artworkId: string): Promise<Listing | null> {
    const listings = await this.listings.listByArtwork(artworkId);
    return listings[0] ?? null;
  }

  private toSummary(artwork: Artwork, listing: Listing | null): ArtworkSummary {
    return {
      id: artwork.id,
      slug: artwork.slug,
      title: artwork.title,
      imageKey: artwork.imageKey,
      imageUrl: artwork.imageKey === null ? null : this.storage.publicUrl(artwork.imageKey),
      availableSupply: availableSupply(artwork),
      maxSupply: artwork.maxSupply,
      price:
        listing === null
          ? null
          : { amount: listing.price.amountMinor, currency: listing.price.currency },
      purchasable: this.isPurchasable(artwork, listing),
      displayState:
        listing === null
          ? 'not_available'
          : resolveDisplayState({ listing, artwork, now: this.clock.now() }),
    };
  }

  /**
   * 購入可否は**ドメインの関数で判定する**。
   *
   * 画面用に別の条件を書くと、表示と実際の購入可否が食い違う。
   */
  private isPurchasable(artwork: Artwork, listing: Listing | null): boolean {
    if (listing === null) {
      return false;
    }
    return evaluatePurchasability({ listing, artwork, now: this.clock.now() }).ok;
  }

  private resolveUnavailableReason(
    artwork: Artwork,
    listing: Listing | null,
  ): ArtworkDetail['unavailableReason'] {
    if (listing === null) {
      return 'listing_not_active';
    }
    const result = evaluatePurchasability({ listing, artwork, now: this.clock.now() });
    if (result.ok) {
      return null;
    }
    // 公開済みの作品しかここへ来ないので `artwork_not_published` は起こらないが、
    // 型の網羅性のために畳んでおく。
    return result.error === 'artwork_not_published' ? 'listing_not_active' : result.error;
  }

  /**
   * 公開向けの出品一覧。
   *
   * 作品が公開されていない出品は返さない。
   * 出品側から作品の非公開が漏れないよう、作品を先に絞ってから引く。
   */
  async listPublicListings(query: {
    limit: number;
    cursor?: string;
  }): Promise<PublicListingListResponse> {
    const page = await this.artworks.listPublished(query);

    const items: PublicListing[] = [];
    for (const artwork of page.items) {
      const listing = await this.listings.findActiveByArtwork(artwork.id);
      if (listing === null) {
        continue;
      }
      items.push(this.toPublicListing(artwork, listing));
    }

    return { items, nextCursor: page.nextCursor };
  }

  /**
   * 公開向けの出品詳細。
   *
   * 見つからない場合と、作品が非公開の場合を同じ `null` で返す。
   * 呼び出し側が 404 に写すことで、非公開作品の存在を観測できなくする。
   */
  async findPublicListing(id: string): Promise<PublicListing | null> {
    const listing = await this.listings.findById(id);
    if (listing === null) {
      return null;
    }
    const artwork = await this.artworks.findById(listing.artworkId);
    if (artwork === null || artwork.status !== 'published') {
      return null;
    }
    // 下書き・終了済みの出品も公開しない。
    if (listing.status !== 'active' && listing.status !== 'scheduled') {
      return null;
    }
    return this.toPublicListing(artwork, listing);
  }

  private toPublicListing(artwork: Artwork, listing: Listing): PublicListing {
    return {
      id: listing.id,
      artworkId: artwork.id,
      artworkSlug: artwork.slug,
      artworkTitle: artwork.title,
      price: { amount: listing.price.amountMinor, currency: listing.price.currency },
      maxQuantityPerOrder: listing.maxQuantityPerOrder,
      displayState: resolveDisplayState({ listing, artwork, now: this.clock.now() }),
      startsAt: listing.startsAt?.toISOString() ?? null,
      endsAt: listing.endsAt?.toISOString() ?? null,
      availableSupply: availableSupply(artwork),
      maxSupply: artwork.maxSupply,
    };
  }
}
