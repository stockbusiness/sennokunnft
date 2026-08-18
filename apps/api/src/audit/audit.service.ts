import { Injectable } from '@nestjs/common';
import type { AuditLogEntryView, AuditLogListResponse } from '@sengoku/contracts';
import type { Actor } from '@sengoku/auth';
import {
  AUDIT_LOG_MAX_PAGE_SIZE,
  AUDIT_LOG_PAGE_SIZE,
  decodeListCursor,
  encodeListCursor,
  redactAuditSummary,
  type AuditLogEntryRecord,
  type AuditLogReadPort,
} from '@sengoku/domain';

/**
 * 監査ログの閲覧（管理画面・外部連携 指示書 §5）。
 *
 * ⚠️ **連絡先を見せる相手を絞る。** スタッフ一覧（`staff.view`）を
 * オーナーだけに開いたのと同じ理由で、ここでも業務用の連絡先を
 * 誰にでも見せない。運営・閲覧者には「誰が」をアカウントIDで見せる。
 *
 * ⚠️ **伏せたことを黙らない。** 何も言わずに伏せると、見た人は
 * 「記録されていない」と読む。記録はあるが見せていない、という違いは
 * 監査では重い。応答に `contactRedacted` を載せて画面に書かせる。
 */
@Injectable()
export class AuditLogQueryService {
  constructor(private readonly auditLogs: AuditLogReadPort) {}

  async list(
    actor: Actor,
    query: {
      readonly action?: string;
      readonly targetType?: string;
      readonly targetId?: string;
      readonly actorAccountId?: string;
      readonly cursor?: string;
      readonly limit?: number;
    },
  ): Promise<AuditLogListResponse> {
    /*
      ⚠️ **`actor.isOwner` を要求の中身から決めない。** 印の正は DB で、
         ガードが読み込んだものがここへ来る。要求に `asOwner=true` の
         ような項目を作らない。
    */
    const includeContact = actor.isOwner;

    const page = await this.auditLogs.list({
      actionPrefix: emptyToNull(query.action),
      targetType: emptyToNull(query.targetType),
      targetId: emptyToNull(query.targetId),
      actorAccountId: emptyToNull(query.actorAccountId),
      cursor: query.cursor === undefined ? null : decodeListCursor(query.cursor),
      limit: clampLimit(query.limit),
      includeActorContact: includeContact,
    });

    return {
      items: page.items.map((item) => toView(item, includeContact)),
      nextCursor: page.nextCursor === null ? null : encodeListCursor(page.nextCursor),
      contactRedacted: !includeContact,
    };
  }
}

function toView(record: AuditLogEntryRecord, includeContact: boolean): AuditLogEntryView {
  return {
    id: record.id,
    actorAccountId: record.actorAccountId,
    actorEmail: includeContact ? record.actorEmail : null,
    action: record.action,
    targetType: record.targetType,
    targetId: record.targetId,
    // ⚠️ 要約の中にも連絡先が入りうる（スタッフ招待の宛先）。必ず通す。
    summary: redactAuditSummary(record.summary, { includeContact }),
    occurredAt: record.occurredAt.toISOString(),
  };
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isSafeInteger(raw) || raw < 1) {
    return AUDIT_LOG_PAGE_SIZE;
  }
  return Math.min(raw, AUDIT_LOG_MAX_PAGE_SIZE);
}

function emptyToNull(value: string | undefined): string | null {
  return value === undefined || value.trim() === '' ? null : value.trim();
}
