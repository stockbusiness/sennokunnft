import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import type {
  NotificationHistoryListResponse,
  NotificationTemplateListResponse,
} from '@sengoku/contracts';
import {
  createNotificationTemplateRequestSchema,
  notificationHistoryQuerySchema,
} from '@sengoku/contracts';
import type { Actor } from '@sengoku/auth';
import { CurrentActor, RequireAction } from '../auth/auth.guard';
import { parseOrThrow } from '../common/validation';
import { NotificationAdminService } from './notification-admin.service';

/**
 * 知らせの文面と送信履歴（P0-4）。
 *
 * ⚠️ **積む口をここに作らない。** 知らせを積むのは業務処理の側で、
 * しかも業務の更新と同じトランザクションで行う。手で送れる口を作ると、
 * 「本当に起きたこと」と「誰かが送ったもの」が混ざり、履歴が意味を失う。
 *
 * ⚠️ **文面を書けるのは運営、公開はオーナーだけ。** 公開した文面は
 * そのまま全購入者へ届く。直したつもりの 1 文字が数千通に載る。
 *
 * ⚠️ **宛先の平文はどの口からも出ない。** 返す型に項目が無い（`UD-503`）。
 */
@Controller('api/v1/admin/notifications')
export class NotificationController {
  constructor(private readonly notifications: NotificationAdminService) {}

  @Get('templates')
  @RequireAction('notification.view')
  listTemplates(): Promise<NotificationTemplateListResponse> {
    return this.notifications.listTemplates();
  }

  /** 新しい版を作る。⚠️ 既存の版は書き換えない。 */
  @Post('templates/:eventType/versions')
  @RequireAction('notification.edit')
  createTemplateVersion(
    @CurrentActor() actor: Actor,
    @Param('eventType') eventType: string,
    @Body() body: unknown,
  ): Promise<{ readonly version: number }> {
    return this.notifications.createTemplateVersion(
      actor,
      eventType,
      parseOrThrow(createNotificationTemplateRequestSchema, body),
    );
  }

  /** 下書きを公開する。⚠️ **オーナーの印が要る。** */
  @Post('templates/:eventType/versions/:version/publish')
  @RequireAction('notification.publish')
  publishTemplate(
    @CurrentActor() actor: Actor,
    @Param('eventType') eventType: string,
    @Param('version') version: string,
  ): Promise<{ readonly published: boolean }> {
    return this.notifications.publishTemplate(actor, eventType, Number.parseInt(version, 10));
  }

  @Get('deliveries')
  @RequireAction('notification.view')
  listHistory(@Query() query: unknown): Promise<NotificationHistoryListResponse> {
    return this.notifications.listHistory(parseOrThrow(notificationHistoryQuerySchema, query));
  }

  /** 手動で送り直す。⚠️ 送れない状態なら断る（画面の見た目に頼らない）。 */
  @Post('deliveries/:id/resend')
  @RequireAction('notification.resend')
  resend(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
  ): Promise<{ readonly requeued: boolean }> {
    return this.notifications.resend(actor, id);
  }
}
