import { Controller, Get, Query } from '@nestjs/common';
import type { AuditLogListResponse } from '@sengoku/contracts';
import type { Actor } from '@sengoku/auth';
import { CurrentActor, RequireAction } from '../auth/auth.guard';
import { AuditLogQueryService } from './audit.service';

/**
 * 監査ログの閲覧（管理画面・外部連携 指示書 §5）。
 *
 * ⚠️ **書き込む経路を作らない。** 監査ログは業務処理が残すもので、
 * 人が足したり直したりできてしまうと、証跡としての意味が消える。
 *
 * ⚠️ **`audit_log.view` は運営と閲覧者の両方に開いている。**
 * ただし操作者の連絡先はオーナーにしか返さない（サービス側で判定）。
 */
@Controller('api/v1/admin/audit-logs')
export class AuditLogController {
  constructor(private readonly auditLogs: AuditLogQueryService) {}

  @Get()
  @RequireAction('audit_log.view')
  list(
    @CurrentActor() actor: Actor,
    @Query('action') action?: string,
    @Query('targetType') targetType?: string,
    @Query('targetId') targetId?: string,
    @Query('actorAccountId') actorAccountId?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<AuditLogListResponse> {
    return this.auditLogs.list(actor, {
      action,
      targetType,
      targetId,
      actorAccountId,
      cursor,
      limit: limit === undefined ? undefined : Number.parseInt(limit, 10),
    });
  }
}
