import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  artworkListQuerySchema,
  createArtworkRequestSchema,
  createListingRequestSchema,
  updateArtworkRequestSchema,
  updateListingRequestSchema,
  type AdminArtwork,
  type AdminArtworkListResponse,
  type AdminListing,
  type AdminListingListResponse,
  type UploadImageResponse,
} from '@sengoku/contracts';
import { z } from '@sengoku/validation';
import type { Actor } from '@sengoku/auth';
import { CurrentActor, RequireAction } from '../auth/auth.guard';
import { IdempotencyService } from '../common/idempotency';
import { assertPlainText } from '../common/sanitize';
import { parseOrThrow } from '../common/validation';
import { AdminCatalogService } from './admin-catalog.service';
import { ArtworkImageService } from './image.service';

const listingListQuerySchema = artworkListQuerySchema.extend({
  artworkId: z.uuid().optional(),
});

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
  constructor(
    private readonly admin: AdminCatalogService,
    private readonly images: ArtworkImageService,
    private readonly idempotency: IdempotencyService,
  ) {}

  // --- 作品 ----------------------------------------------------------------

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
  createArtwork(
    @Body() body: unknown,
    @CurrentActor() actor: Actor,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<AdminArtwork> {
    const request = parseOrThrow(createArtworkRequestSchema, body);
    // 説明文とタイトルに HTML を保存しない（保存型 XSS の芽を断つ）。
    assertPlainText(request.title, { field: 'title', maxLength: 120 });
    if (request.description !== undefined) {
      assertPlainText(request.description, { field: 'description', maxLength: 4000 });
    }
    return this.withIdempotency(actor, idempotencyKey, 'artwork.create', request, () =>
      this.admin.createArtwork(request, requireActorId(actor)),
    );
  }

  @Patch('artworks/:id')
  @RequireAction('artwork.manage')
  updateArtwork(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentActor() actor: Actor,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<AdminArtwork> {
    const request = parseOrThrow(updateArtworkRequestSchema, body);
    if (request.title !== undefined) {
      assertPlainText(request.title, { field: 'title', maxLength: 120 });
    }
    if (request.description !== undefined) {
      assertPlainText(request.description, { field: 'description', maxLength: 4000 });
    }
    return this.withIdempotency(actor, idempotencyKey, `artwork.update:${id}`, request, () =>
      this.admin.updateArtwork(id, request, requireActorId(actor)),
    );
  }

  @Post('artworks/:id/publish')
  @HttpCode(200)
  @RequireAction('artwork.manage')
  publishArtwork(
    @Param('id') id: string,
    @CurrentActor() actor: Actor,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<AdminArtwork> {
    return this.withIdempotency(actor, idempotencyKey, `artwork.publish:${id}`, null, () =>
      this.admin.publishArtwork(id, requireActorId(actor)),
    );
  }

  @Post('artworks/:id/archive')
  @HttpCode(200)
  @RequireAction('artwork.manage')
  archiveArtwork(
    @Param('id') id: string,
    @CurrentActor() actor: Actor,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<AdminArtwork> {
    return this.withIdempotency(actor, idempotencyKey, `artwork.archive:${id}`, null, () =>
      this.admin.archiveArtwork(id, requireActorId(actor)),
    );
  }

  /**
   * 作品画像の登録。
   *
   * 生のバイト列を受け取る（`Content-Type` に画像の MIME を指定して送る）。
   * multipart を使わないのは、境界の解析を増やさないため。
   * **判定は中身のマジックナンバーで行い、ヘッダは照合にしか使わない。**
   */
  @Post('artworks/:id/image')
  @HttpCode(200)
  @RequireAction('artwork.manage')
  uploadImage(
    @Param('id') id: string,
    @Req() request: Request,
    @CurrentActor() actor: Actor,
  ): Promise<UploadImageResponse> {
    // express.raw ミドルウェアが Buffer を入れている（AppModule.configure）。
    const bytes = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    const declared = request.headers['content-type']?.split(';')[0]?.trim();
    return this.images.upload({
      artworkId: id,
      actorAccountId: requireActorId(actor),
      bytes: new Uint8Array(bytes),
      declaredContentType: declared === undefined || declared === '' ? undefined : declared,
    });
  }

  // --- 出品 ----------------------------------------------------------------

  @Get('listings')
  @RequireAction('listing.manage')
  listListings(@Query() rawQuery: unknown): Promise<AdminListingListResponse> {
    const query = parseOrThrow(listingListQuerySchema, rawQuery);
    return this.admin.listListings({
      limit: query.limit,
      cursor: query.cursor,
      artworkId: query.artworkId,
    });
  }

  @Get('listings/:id')
  @RequireAction('listing.manage')
  getListing(@Param('id') id: string): Promise<AdminListing> {
    return this.admin.getListing(id);
  }

  @Post('listings')
  @RequireAction('listing.manage')
  createListing(
    @Body() body: unknown,
    @CurrentActor() actor: Actor,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<AdminListing> {
    const request = parseOrThrow(createListingRequestSchema, body);
    return this.withIdempotency(actor, idempotencyKey, 'listing.create', request, () =>
      this.admin.createListing(request, requireActorId(actor)),
    );
  }

  @Patch('listings/:id')
  @RequireAction('listing.manage')
  updateListing(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentActor() actor: Actor,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<AdminListing> {
    const request = parseOrThrow(updateListingRequestSchema, body);
    return this.withIdempotency(actor, idempotencyKey, `listing.update:${id}`, request, () =>
      this.admin.updateListing(id, request, requireActorId(actor)),
    );
  }

  @Post('listings/:id/activate')
  @HttpCode(200)
  @RequireAction('listing.manage')
  activateListing(
    @Param('id') id: string,
    @CurrentActor() actor: Actor,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<AdminListing> {
    return this.withIdempotency(actor, idempotencyKey, `listing.activate:${id}`, null, () =>
      this.admin.activateListing(id, requireActorId(actor)),
    );
  }

  @Post('listings/:id/suspend')
  @HttpCode(200)
  @RequireAction('listing.manage')
  suspendListing(
    @Param('id') id: string,
    @CurrentActor() actor: Actor,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<AdminListing> {
    return this.withIdempotency(actor, idempotencyKey, `listing.suspend:${id}`, null, () =>
      this.admin.suspendListing(id, requireActorId(actor)),
    );
  }

  @Post('listings/:id/end')
  @HttpCode(200)
  @RequireAction('listing.manage')
  endListing(
    @Param('id') id: string,
    @CurrentActor() actor: Actor,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<AdminListing> {
    return this.withIdempotency(actor, idempotencyKey, `listing.end:${id}`, null, () =>
      this.admin.endListing(id, requireActorId(actor)),
    );
  }

  /**
   * 冪等キーがあれば、同じキー・同じ内容の再送に前回の結果を返す。
   *
   * キーが無い場合はそのまま実行する。カタログ操作は作り直せるので、
   * ここでキー必須にはしていない。取り返しのつかない注文（Phase 3）では
   * 必須にし、DB の一意制約で担保する。
   */
  private async withIdempotency<T>(
    actor: Actor,
    rawKey: string | undefined,
    scope: string,
    payload: unknown,
    execute: () => Promise<T>,
  ): Promise<T> {
    const key = this.idempotency.normalizeKey(rawKey);
    if (key === null) {
      return execute();
    }
    const actorId = requireActorId(actor);
    const digest = this.idempotency.digest(scope, payload);

    const existing = this.idempotency.lookup(actorId, key, digest);
    if (existing !== null) {
      return existing.body as T;
    }

    const result = await execute();
    this.idempotency.remember(actorId, key, digest, 200, result);
    return result;
  }
}

/** ガードを通っているので必ず存在するが、型のために確認する。 */
function requireActorId(actor: Actor): string {
  if (actor.accountId === null) {
    throw new Error('actor is not authenticated');
  }
  return actor.accountId;
}
