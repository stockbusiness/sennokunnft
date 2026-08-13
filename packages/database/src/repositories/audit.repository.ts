import type { AuditEntry, AuditLogPort } from '@sengoku/domain';
import type { PrismaClient } from '../../generated/client';

/**
 * 監査記録の永続化。
 *
 * 記録の失敗で業務操作を巻き戻すべきかは操作によって変わるため、
 * ここでは例外をそのまま投げる。呼び出し側が扱いを決める。
 * （画像の置換のように「記録できなくても操作は成立している」場面もある）
 */
export class PrismaAuditLogRepository implements AuditLogPort {
  constructor(private readonly prisma: PrismaClient) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        actorAccountId: entry.actorAccountId,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        // ⚠️ 呼び出し側が秘匿値を入れない前提。ここでは中身を検査しない。
        summary: entry.summary as never,
      },
    });
  }
}
