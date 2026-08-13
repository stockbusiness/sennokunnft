import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import {
  artworkListQuerySchema,
  type ArtworkDetail,
  type ArtworkListResponse,
} from '@sengoku/contracts';
import { Public } from '../auth/auth.guard';
import { parseOrThrow } from '../common/validation';
import { CatalogService } from './catalog.service';

/**
 * 公開カタログ。認証を要求しない。
 *
 * ⚠️ `@Public()` を付けたエンドポイントは誰でも到達できる。
 * ここで返してよいのは、公開済みの作品に関する情報だけ。
 */
@Controller('api/v1/artworks')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  @Public()
  list(@Query() rawQuery: unknown): Promise<ArtworkListResponse> {
    const query = parseOrThrow(artworkListQuerySchema, rawQuery);
    return this.catalog.listPublished({ limit: query.limit, cursor: query.cursor });
  }

  @Get(':slug')
  @Public()
  async detail(@Param('slug') slug: string): Promise<ArtworkDetail> {
    const artwork = await this.catalog.findPublishedBySlug(slug);
    if (artwork === null) {
      // 存在しない場合と非公開の場合を区別しない。
      // 区別すると、未公開作品の存在を外部から観測できてしまう。
      throw new NotFoundException();
    }
    return artwork;
  }
}
