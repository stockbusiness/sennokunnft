import type {
  AuditEntry,
  AuditLogEntryRecord,
  AuditLogPage,
  AuditLogPort,
  AuditLogQuery,
  AuditLogReadPort,
} from '@sengoku/domain';
import type { Prisma, PrismaClient } from '../../generated/client';

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

/**
 * 監査記録の閲覧（管理画面・外部連携 指示書 §5）。
 *
 * ⚠️ **書く側とクラスを分けてある。** 記録は業務処理のあちこちから呼ばれる。
 * そこへ一覧の実装まで載せると、監査を記録したいだけの箇所が
 * 検索条件の組み立てごと抱え込むことになる。
 *
 * ⚠️ **連絡先は要求されたときだけ読む。** 「読んでから出すかどうか決める」
 * のではなく、出さないと決まっているなら **JOIN ごと行わない**。
 */
export class PrismaAuditLogReadRepository implements AuditLogReadPort {
  constructor(private readonly prisma: PrismaClient) {}

  async list(query: AuditLogQuery): Promise<AuditLogPage> {
    const rows = await this.prisma.auditLog.findMany({
      where: whereFor(query),
      // 新しい順。同時刻の行が並んでも順序がぶれないよう行IDまで含める。
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      // 1 件多く取り、続きの有無を「取れたかどうか」で判定する。
      take: query.limit + 1,
      select: {
        id: true,
        actorAccountId: true,
        action: true,
        targetType: true,
        targetId: true,
        summary: true,
        occurredAt: true,
        // ⚠️ 出さないと決まっているなら、JOIN ごと行わない。
        actor: query.includeActorContact ? { select: { staffEmail: true } } : false,
      },
    });

    const hasMore = rows.length > query.limit;
    const items = (hasMore ? rows.slice(0, query.limit) : rows).map(toEntry);
    const last = items.at(-1);

    return {
      items,
      nextCursor: hasMore && last !== undefined ? { at: last.occurredAt, id: last.id } : null,
    };
  }
}

function whereFor(query: AuditLogQuery): Prisma.AuditLogWhereInput {
  const where: Prisma.AuditLogWhereInput = {};

  if (query.actionPrefix !== null) {
    // ⚠️ `contains` にしない。`staff` で `integration.staff_sync` まで
    //    拾ってしまい、絞り込んだつもりが絞れていない。
    where.action = { startsWith: query.actionPrefix };
  }
  if (query.targetType !== null) {
    where.targetType = query.targetType;
  }
  if (query.targetId !== null) {
    where.targetId = query.targetId;
  }
  if (query.actorAccountId !== null) {
    where.actorAccountId = query.actorAccountId;
  }

  const cursor = query.cursor;
  if (cursor !== null) {
    where.OR = [
      { occurredAt: { lt: cursor.at } },
      { occurredAt: cursor.at, id: { lt: cursor.id } },
    ];
  }

  return where;
}

function toEntry(row: {
  id: string;
  actorAccountId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  summary: unknown;
  occurredAt: Date;
  actor?: { staffEmail: string | null } | null;
}): AuditLogEntryRecord {
  return {
    id: row.id,
    actorAccountId: row.actorAccountId,
    actorEmail: row.actor?.staffEmail ?? null,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    // ⚠️ ここでは伏せない。誰に見せるかを知っているのは呼び出し側。
    //    伏せ方を 2 か所に置くと、片方だけ直されて必ずずれる。
    summary: asRecord(row.summary),
    occurredAt: row.occurredAt,
  };
}

/**
 * `Json` 列を素直な連想配列にする。
 *
 * 列は `Json` なので、配列や数値が入っている行もありうる（過去の記録や
 * 手で入れた行）。想定外の形で画面を落とさないよう、空にして通す。
 */
function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}
