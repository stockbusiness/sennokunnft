import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  CreateNotificationTemplateRequest,
  NotificationHistoryListResponse,
  NotificationTemplateListResponse,
} from '@sengoku/contracts';
import {
  allowedVariables,
  canResendNotification,
  isNotificationEventType,
  NOTIFICATION_EVENT_TYPES,
  validateTemplate,
  type AuditLogPort,
  type ClockPort,
  type NotificationEventType,
  type NotificationHistoryPort,
  type NotificationOutboxPort,
  type NotificationTemplateRepository,
} from '@sengoku/domain';
import type { Actor } from '@sengoku/auth';
import { DomainErrorException } from '../common/domain-error.filter';

/**
 * 文面の編集と送信履歴の閲覧（P0-4）。
 *
 * ⚠️ **送信履歴に本文と宛先の平文を持ち出さない。** 読む口（`NotificationHistoryPort`）
 * が返す型に、そもそもその項目が無い。
 */
@Injectable()
export class NotificationAdminService {
  constructor(
    private readonly templates: NotificationTemplateRepository,
    private readonly history: NotificationHistoryPort,
    private readonly outbox: NotificationOutboxPort,
    private readonly clock: ClockPort,
    private readonly audit: AuditLogPort,
  ) {}

  async listTemplates(): Promise<NotificationTemplateListResponse> {
    const items = await this.templates.listAll();
    return {
      items: items.map((row) => ({
        eventType: row.eventType,
        version: row.version,
        subject: row.subject,
        body: row.body,
        status: row.status,
        publishedAt: row.publishedAt?.toISOString() ?? null,
        updatedAt: row.updatedAt.toISOString(),
      })),
      /*
        ⚠️ **差し込める語を画面へ渡す。** 渡さないと、書く人は語彙を
           知らないまま書き、公開の段になって初めて弾かれる。
      */
      variables: Object.fromEntries(
        NOTIFICATION_EVENT_TYPES.map((eventType) => [eventType, [...allowedVariables(eventType)]]),
      ) as NotificationTemplateListResponse['variables'],
    };
  }

  /**
   * 新しい版を作る。⚠️ **既存の版は書き換えない。**
   */
  async createTemplateVersion(
    actor: Actor,
    eventType: string,
    input: CreateNotificationTemplateRequest,
  ): Promise<{ readonly version: number }> {
    const kind = this.parseEventType(eventType);

    /*
      ⚠️ **公開の時点で弾く。送る時点ではない。** 送る時点で気づいても、
         そのときには知らせが止まっているだけで、直せるのは次の 1 通から。
    */
    const validated = validateTemplate({
      eventType: kind,
      subject: input.subject,
      body: input.body,
    });
    if (!validated.ok) {
      throw new DomainErrorException(validated.error.code);
    }

    const created = await this.templates.createVersion({
      eventType: kind,
      subject: input.subject,
      body: input.body,
      status: input.publish ? 'published' : 'draft',
      actorAccountId: actor.accountId,
      now: this.clock.now(),
    });

    await this.audit.record({
      actorAccountId: actor.accountId,
      action: input.publish ? 'notification.template_published' : 'notification.template_drafted',
      targetType: 'notification_template',
      targetId: `${kind}:${String(created.version)}`,
      // ⚠️ 文面そのものは残さない。版を辿れば読める。
      summary: { eventType: kind, version: created.version },
    });

    return { version: created.version };
  }

  /** 下書きを公開する。⚠️ オーナーの印が要る（認可側で縛る）。 */
  async publishTemplate(
    actor: Actor,
    eventType: string,
    version: number,
  ): Promise<{ readonly published: boolean }> {
    const kind = this.parseEventType(eventType);
    const published = await this.templates.publish({
      eventType: kind,
      version,
      actorAccountId: actor.accountId,
      now: this.clock.now(),
    });
    if (!published) {
      // すでに公開済み、または存在しない。⚠️ 黙って成功にしない。
      throw new NotFoundException();
    }
    await this.audit.record({
      actorAccountId: actor.accountId,
      action: 'notification.template_published',
      targetType: 'notification_template',
      targetId: `${kind}:${String(version)}`,
      summary: { eventType: kind, version },
    });
    return { published: true };
  }

  listHistory(query: {
    readonly status?: string | undefined;
    readonly eventType?: string | undefined;
    readonly subjectId?: string | undefined;
    readonly limit: number;
    readonly cursor?: string | undefined;
  }): Promise<NotificationHistoryListResponse> {
    return this.history
      .list({
        status: query.status as never,
        eventType: query.eventType as never,
        subjectId: query.subjectId,
        limit: query.limit,
        cursor: query.cursor,
      })
      .then((page) => ({
        items: page.items.map((row) => ({
          id: row.id,
          eventType: row.eventType,
          subjectType: row.subjectType,
          subjectId: row.subjectId,
          maskedRecipient: row.maskedRecipient,
          templateVersion: row.templateVersion,
          subject: row.subject,
          status: row.status,
          attemptCount: row.attemptCount,
          lastErrorCode: row.lastErrorCode,
          skippedReasonCode: row.skippedReasonCode,
          sentAt: row.sentAt?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
        })),
        nextCursor: page.nextCursor,
      }));
  }

  /**
   * 手動で送り直す。
   *
   * ⚠️ **送れる状態かをドメインに聞く。** 画面の見た目でボタンを出す／
   * 出さないだけにすると、URL を直接叩かれたときに素通りする。
   */
  async resend(actor: Actor, id: string): Promise<{ readonly requeued: boolean }> {
    const record = await this.history.findById(id);
    if (record === null) {
      throw new NotFoundException();
    }
    if (!canResendNotification(record.status)) {
      throw new DomainErrorException('NOTIFICATION_NOT_RESENDABLE');
    }
    const requeued = await this.outbox.requeue({ id, now: this.clock.now() });
    if (requeued) {
      await this.audit.record({
        actorAccountId: actor.accountId,
        action: 'notification.resent',
        targetType: 'notification',
        targetId: id,
        // ⚠️ 宛先も本文も残さない。
        summary: { eventType: record.eventType, previousStatus: record.status },
      });
    }
    return { requeued };
  }

  private parseEventType(value: string): NotificationEventType {
    if (!isNotificationEventType(value)) {
      throw new NotFoundException();
    }
    return value;
  }
}
