import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  artworkListQuerySchema,
  createArtworkRequestSchema,
  createListingRequestSchema,
  updateArtworkRequestSchema,
  updateListingRequestSchema,
  type AdminArtwork,
  type AdminArtworkListResponse,
  type AdminListing,
} from '@sengoku/contracts';
import { RequireAction } from '../auth/auth.guard';
import { parseOrThrow } from '../common/validation';
import { AdminCatalogService } from './admin-catalog.service';

/**
 * 運営用のカタログ管理。
 *
 * ✅ **認可はミドルウェア（ガード）で一括保護する。**
 * ルートごとに `if (role !== 'operator')` を書かない。
 * 個別に書くと、必ずどこかで書き忘れて保護漏れになる。
 *
 * 各ハンドラは `@RequireAction` で必要な操作を宣言するだけ。
 * 宣言が無いエンドポイントはガードが拒否する（既定 deny）。
 */
@Controller('api/v1/admin')
export class AdminCatalogController {
  constructor(private readonly admin: AdminCatalogService) {}

  @Get('artworks')
  @RequireAction('artwork.view_unpublished')
  listArtworks(@Query() rawQuery: unknown): Promise<AdminArtworkListResponse> {
    const query = parseOrThrow(artworkListQuerySchema, rawQuery);
    return this.admin.listArtworks({ limit: query.limit, cursor: query.cursor });
  }

  @Get('artworks/:id')
  @RequireAction('artwork.view_unpublished')
  getArtwork(@Param('id') id: string): Promise<AdminArtwork> {
    return this.admin.getArtwork(id);
  }

  @Post('artworks')
  @RequireAction('artwork.manage')
  createArtwork(@Body() body: unknown): Promise<AdminArtwork> {
    return this.admin.createArtwork(parseOrThrow(createArtworkRequestSchema, body));
  }

  @Patch('artworks/:id')
  @RequireAction('artwork.manage')
  updateArtwork(@Param('id') id: string, @Body() body: unknown): Promise<AdminArtwork> {
    return this.admin.updateArtwork(id, parseOrThrow(updateArtworkRequestSchema, body));
  }

  @Post('artworks/:id/publish')
  @RequireAction('artwork.manage')
  publishArtwork(@Param('id') id: string): Promise<AdminArtwork> {
    return this.admin.publishArtwork(id);
  }

  @Post('artworks/:id/archive')
  @RequireAction('artwork.manage')
  archiveArtwork(@Param('id') id: string): Promise<AdminArtwork> {
    return this.admin.archiveArtwork(id);
  }

  @Get('artworks/:id/listings')
  @RequireAction('listing.manage')
  listListings(@Param('id') id: string): Promise<AdminListing[]> {
    return this.admin.listListings(id);
  }

  @Post('listings')
  @RequireAction('listing.manage')
  createListing(@Body() body: unknown): Promise<AdminListing> {
    return this.admin.createListing(parseOrThrow(createListingRequestSchema, body));
  }

  @Patch('listings/:id')
  @RequireAction('listing.manage')
  updateListing(@Param('id') id: string, @Body() body: unknown): Promise<AdminListing> {
    return this.admin.updateListing(id, parseOrThrow(updateListingRequestSchema, body));
  }

  @Post('listings/:id/activate')
  @RequireAction('listing.manage')
  activateListing(@Param('id') id: string): Promise<AdminListing> {
    return this.admin.activateListing(id);
  }

  @Post('listings/:id/pause')
  @RequireAction('listing.manage')
  pauseListing(@Param('id') id: string): Promise<AdminListing> {
    return this.admin.pauseListing(id);
  }

  @Post('listings/:id/close')
  @RequireAction('listing.manage')
  closeListing(@Param('id') id: string): Promise<AdminListing> {
    return this.admin.closeListing(id);
  }
}
