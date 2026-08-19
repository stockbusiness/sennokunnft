import { BadRequestException, Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import type {
  LegalVersionListResponse,
  LegalVersionView,
  PublicLegalDocument,
} from '@sengoku/contracts';
import { publishLegalVersionRequestSchema, saveLegalDraftRequestSchema } from '@sengoku/contracts';
import type { Actor } from '@sengoku/auth';
import { isLegalDocumentKind, type LegalDocumentKind } from '@sengoku/domain';
import { CurrentActor, Public, RequireAction } from '../auth/auth.guard';
import { parseOrThrow } from '../common/validation';
import { LegalService } from './legal.service';

/**
 * 法務文書の公開ページ向け。認証を要求しない。
 *
 * ⚠️ **施行中の版だけを返す。** 下書きも、施行日が来ていない版も出さない。
 * 予約した版が先に見えると、まだ効いていない条件を購入者が読むことになる。
 */
@Controller('api/v1/legal')
export class PublicLegalController {
  constructor(private readonly legal: LegalService) {}

  @Get(':kind')
  @Public()
  read(@Param('kind') kind: string): Promise<PublicLegalDocument> {
    return this.legal.public(parseKind(kind));
  }
}

/**
 * 法務文書の管理（運営）。
 *
 * ⚠️ **下書きは `legal.edit`、公開は `legal.publish`（オーナー限定）。**
 * 公開した版は取り消せず、書いた内容は購入者への約束になる。
 * 書く人と決める人を分ける。判定はガードが済ませており、ここで再判定しない。
 *
 * ⚠️ **削除の口を作らない。** 過去の版は残す。
 */
@Controller('api/v1/admin/legal')
export class AdminLegalController {
  constructor(private readonly legal: LegalService) {}

  @Get(':kind')
  @RequireAction('legal.view')
  list(@Param('kind') kind: string): Promise<LegalVersionListResponse> {
    return this.legal.list(parseKind(kind));
  }

  /**
   * 下書きを保存する。
   *
   * ⚠️ **PUT で「その種類の下書き」を指す。** 下書きは種類ごとに 1 つなので、
   * ID を画面に持たせない。持たせると、古い画面から別の下書きへ
   * 書き込む余地が生まれる。
   */
  @Put(':kind/draft')
  @RequireAction('legal.edit')
  saveDraft(
    @CurrentActor() actor: Actor,
    @Param('kind') kind: string,
    @Body() body: unknown,
  ): Promise<LegalVersionView> {
    return this.legal.saveDraft(
      actor,
      parseKind(kind),
      parseOrThrow(saveLegalDraftRequestSchema, body),
    );
  }

  @Post(':kind/publish')
  @RequireAction('legal.publish')
  publish(
    @CurrentActor() actor: Actor,
    @Param('kind') kind: string,
    @Body() body: unknown,
  ): Promise<LegalVersionView> {
    return this.legal.publish(
      actor,
      parseKind(kind),
      parseOrThrow(publishLegalVersionRequestSchema, body),
    );
  }
}

function parseKind(value: string): LegalDocumentKind {
  if (!isLegalDocumentKind(value)) {
    throw new BadRequestException({
      error: { code: 'VALIDATION_ERROR', message: '文書の種類が不正です。' },
    });
  }
  return value;
}
