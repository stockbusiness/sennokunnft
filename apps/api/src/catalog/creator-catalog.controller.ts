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
  type CreatorArtwork,
  type CreatorListing,
  type UploadImageResponse,
} from '@sengoku/contracts';
import type { Actor } from '@sengoku/auth';
import { CurrentActor, RequireAction } from '../auth/auth.guard';
import { IdempotencyService } from '../common/idempotency';
import { assertPlainText } from '../common/sanitize';
import { parseOrThrow } from '../common/validation';
import { CreatorCatalogService } from './creator-catalog.service';
import { ArtworkImageService } from './image.service';

/**
 * 出品者が自分の作品を扱う入口（`UD-102` 決定変更 2026-08-18）。
 *
 * ⚠️ **管理API（`/api/v1/admin/**`）と入口を分けてある。**
 * あちらは `operator` を一括で要求することが守りになっている。
 * 「所有者なら通す」に変えると、その性質が失われ、
 * どこか一箇所の書き漏れが他人のデータへの到達に変わる。
 *
 * ⚠️ **ここでは `@RequireAction` はロール段階までしか見ない。**
 * 「その作品はあなたのものか」は `CreatorCatalogService` が
 * 対象を読み込んでから確かめる。ガードは対象を知らないため。
 */
@Controller('api/v1/creator')
export class CreatorCatalogController {
  constructor(
    private readonly creator: CreatorCatalogService,
    private readonly images: ArtworkImageService,
    private readonly idempotency: IdempotencyService,
  ) {}

  // --- 作品 ----------------------------------------------------------------

  @Get('artworks')
  @RequireAction('artwork.manage_own')
  listArtworks(
    @CurrentActor() actor: Actor,
    @Query() rawQuery: unknown,
  ): Promise<{ items: CreatorArtwork[]; nextCursor: string | null }> {
    const query = parseOrThrow(artworkListQuerySchema, rawQuery);
    return this.creator.listMyArtworks(actor, { limit: query.limit, cursor: query.cursor });
  }

  @Get('artworks/:id')
  @RequireAction('artwork.manage_own')
  getArtwork(@CurrentActor() actor: Actor, @Param('id') id: string): Promise<CreatorArtwork> {
    return this.creator.getMyArtwork(actor, id);
  }

  @Post('artworks')
  @RequireAction('artwork.create_own')
  createArtwork(
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<CreatorArtwork> {
    const request = parseOrThrow(createArtworkRequestSchema, body);
    // 説明文とタイトルに HTML を保存しない（保存型 XSS の芽を断つ）。
    assertPlainText(request.title, { field: 'title', maxLength: 120 });
    if (request.description !== undefined) {
      assertPlainText(request.description, { field: 'description', maxLength: 4000 });
    }
    return this.withIdempotency(actor, idempotencyKey, 'creator.artwork.create', request, () =>
      this.creator.createArtwork(actor, request),
    );
  }

  @Patch('artworks/:id')
  @RequireAction('artwork.manage_own')
  updateArtwork(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<CreatorArtwork> {
    const request = parseOrThrow(updateArtworkRequestSchema, body);
    if (request.title !== undefined) {
      assertPlainText(request.title, { field: 'title', maxLength: 120 });
    }
    if (request.description !== undefined) {
      assertPlainText(request.description, { field: 'description', maxLength: 4000 });
    }
    return this.withIdempotency(
      actor,
      idempotencyKey,
      `creator.artwork.update:${id}`,
      request,
      () => this.creator.updateArtwork(actor, id, request),
    );
  }

  @Post('artworks/:id/publish')
  @HttpCode(200)
  @RequireAction('artwork.manage_own')
  publishArtwork(@CurrentActor() actor: Actor, @Param('id') id: string): Promise<CreatorArtwork> {
    return this.creator.publishArtwork(actor, id);
  }

  @Post('artworks/:id/archive')
  @HttpCode(200)
  @RequireAction('artwork.manage_own')
  archiveArtwork(@CurrentActor() actor: Actor, @Param('id') id: string): Promise<CreatorArtwork> {
    return this.creator.archiveArtwork(actor, id);
  }

  /**
   * 作品画像の登録。生のバイト列で受け取る（`AppModule.configure`）。
   *
   * ⚠️ **所有権を先に確かめてから保存する。** 逆順にすると、
   * 他人の作品IDを指定した画像がストレージに残る。
   */
  @Post('artworks/:id/image')
  @HttpCode(200)
  @RequireAction('artwork.manage_own')
  async uploadImage(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Req() request: Request,
  ): Promise<UploadImageResponse> {
    await this.creator.assertOwnsArtwork(actor, id);
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

  @Get('artworks/:id/listings')
  @RequireAction('listing.manage_own')
  listListings(
    @CurrentActor() actor: Actor,
    @Param('id') artworkId: string,
  ): Promise<{ items: CreatorListing[]; nextCursor: string | null }> {
    return this.creator.listMyListings(actor, artworkId);
  }

  @Post('listings')
  @RequireAction('listing.manage_own')
  createListing(
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<CreatorListing> {
    const request = parseOrThrow(createListingRequestSchema, body);
    return this.withIdempotency(actor, idempotencyKey, 'creator.listing.create', request, () =>
      this.creator.createListing(actor, request),
    );
  }

  @Patch('listings/:id')
  @RequireAction('listing.manage_own')
  updateListing(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<CreatorListing> {
    const request = parseOrThrow(updateListingRequestSchema, body);
    return this.withIdempotency(
      actor,
      idempotencyKey,
      `creator.listing.update:${id}`,
      request,
      () => this.creator.updateListing(actor, id, request),
    );
  }

  @Post('listings/:id/activate')
  @HttpCode(200)
  @RequireAction('listing.manage_own')
  activateListing(@CurrentActor() actor: Actor, @Param('id') id: string): Promise<CreatorListing> {
    return this.creator.activateListing(actor, id);
  }

  @Post('listings/:id/suspend')
  @HttpCode(200)
  @RequireAction('listing.manage_own')
  suspendListing(@CurrentActor() actor: Actor, @Param('id') id: string): Promise<CreatorListing> {
    return this.creator.suspendListing(actor, id);
  }

  @Post('listings/:id/end')
  @HttpCode(200)
  @RequireAction('listing.manage_own')
  endListing(@CurrentActor() actor: Actor, @Param('id') id: string): Promise<CreatorListing> {
    return this.creator.endListing(actor, id);
  }

  /** 冪等キーがあれば、同じキー・同じ内容の再送に前回の結果を返す。 */
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

    const outcome = await this.idempotency.begin<T>(actorId, key, digest);
    if (outcome.kind === 'replay') {
      return outcome.body;
    }

    let result: T;
    try {
      result = await execute();
    } catch (error) {
      // ⚠️ 本体が失敗したときだけ解放する。解放しないと、一度失敗した
      //    だけのキーが期限切れまで塞がり、やり直せなくなる。
      await outcome.claim.release().catch(() => undefined);
      throw error;
    }

    // ⚠️ ここで失敗しても解放しない。本体は既に成功している。
    //    塞がったままなら「やり直せない」で済むが、解放すると「二重に実行される」。
    await outcome.claim.complete(200, result);
    return result;
  }
}

function requireActorId(actor: Actor): string {
  if (actor.accountId === null) {
    // AuthGuard を通っている以上ここには来ない。来たら配線の誤り。
    throw new Error('authenticated actor has no account id');
  }
  return actor.accountId;
}
