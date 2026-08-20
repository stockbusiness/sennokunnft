import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import type { OperationsReviewListResponse } from '@sengoku/contracts';
import { resolveOperationsReviewRequestSchema } from '@sengoku/contracts';
import type { Actor } from '@sengoku/auth';
import { CurrentActor, RequireAction } from '../auth/auth.guard';
import { parseOrThrow } from '../common/validation';
import { OperationsReviewService } from './operations-review.service';

/**
 * 運用確認キューの画面（M3a）。
 *
 * ⚠️ **積む口をここに作らない。** 積むのは業務処理の側で、しかも業務の
 * 更新と同じトランザクションで行う。手で足せると、「本当に起きた確認事項」と
 * 「誰かが作った行」が混ざり、件数が意味を失う。
 *
 * ⚠️ **消す口も作らない。** 対応済みにするだけ。片づけたい気持ちで
 * 消せるようにすると、確認しなかったことまで消える。
 *
 * ⚠️ **閲覧は `operations_review.view`、対応済みは `operations_review.resolve`。**
 * 閲覧者（auditor）は何件残っているか見られるが、印は付けられない。
 */
@Controller('api/v1/admin/operations-reviews')
export class OperationsReviewController {
  constructor(private readonly reviews: OperationsReviewService) {}

  @Get()
  @RequireAction('operations_review.view')
  list(
    @Query('status') status?: string | string[],
    @Query('reasonCode') reasonCode?: string | string[],
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<OperationsReviewListResponse> {
    return this.reviews.list({
      // `?status=open&status=resolved` は配列で、1 つだけなら文字列で届く。
      status: status === undefined ? undefined : Array.isArray(status) ? status : [status],
      reasonCode:
        reasonCode === undefined
          ? undefined
          : Array.isArray(reasonCode)
            ? reasonCode
            : [reasonCode],
      cursor,
      limit: limit === undefined ? undefined : Number.parseInt(limit, 10),
    });
  }

  @Post(':id/resolve')
  @RequireAction('operations_review.resolve')
  resolve(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ readonly resolved: boolean }> {
    return this.reviews.resolve(
      actor,
      id,
      parseOrThrow(resolveOperationsReviewRequestSchema, body),
    );
  }
}
