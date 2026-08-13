import { Injectable } from '@nestjs/common';
import type { ArtworkDetail, ArtworkListResponse, ArtworkSummary } from '@sengoku/contracts';
import {
  availableSupply,
  evaluatePurchasability,
  type Artwork,
  type ArtworkRepository,
  type ClockPort,
  type Listing,
  type ListingRepository,
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

    const listing = await this.listings.findActiveByArtwork(artwork.id);
    const summary = this.toSummary(artwork, listing);

    return {
      ...summary,
      description: artwork.description,
      listingId: listing?.id ?? null,
      maxQuantityPerOrder: listing?.maxQuantityPerOrder ?? null,
      unavailableReason: this.resolveUnavailableReason(artwork, listing),
    };
  }

  private toSummary(artwork: Artwork, listing: Listing | null): ArtworkSummary {
    return {
      id: artwork.id,
      slug: artwork.slug,
      title: artwork.title,
      imageKey: artwork.imageKey,
      availableSupply: availableSupply(artwork),
      maxSupply: artwork.maxSupply,
      price:
        listing === null
          ? null
          : { amount: listing.price.amountMinor, currency: listing.price.currency },
      purchasable: this.isPurchasable(artwork, listing),
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
}
