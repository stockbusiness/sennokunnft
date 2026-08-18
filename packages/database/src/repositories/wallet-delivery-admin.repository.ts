import type {
  WalletDeliveryAdminPage,
  WalletDeliveryAdminPort,
  WalletDeliveryAdminQuery,
  WalletDeliveryAdminRecord,
  WalletDeliveryEventType,
  WalletDeliveryOutboxStatus,
  WalletDeliveryStatusCounts,
} from '@sengoku/domain';
import type { Prisma, PrismaClient } from '../../generated/client';

/**
 * 送信の運用画面が読む口（管理画面・外部連携 指示書 §5）。
 *
 * ⚠️ **`payload` を SELECT しない。** 取ってから捨てるのではなく、
 * **最初から取らない**。取ってしまえば、その値はこのプロセスのメモリに乗り、
 * 例外のスタックやログの出力対象になりうる。列を選ばなければ、
 * 事故の起きようがない。指示書 §5「送った本文全体を無条件で表示しない」。
 *
 * ⚠️ **`Authorization` ヘッダー・API キー・HMAC 署名値はここに無い。**
 * それらは送信のたびに組み立てられ、行には保存していない。
 * 「運用が困るから残そう」と言われても残さない。
 */
export class PrismaWalletDeliveryAdminRepository implements WalletDeliveryAdminPort {
  constructor(private readonly prisma: PrismaClient) {}

  async list(query: WalletDeliveryAdminQuery): Promise<WalletDeliveryAdminPage> {
    const rows = await this.prisma.walletDeliveryOutbox.findMany({
      where: whereFor(query),
      // 新しい順。同じ時刻の行が並んでも順序がぶれないよう、行IDまで含める。
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      // 1 件多く取り、続きがあるかを「取れたかどうか」で判定する。
      // 別に COUNT を投げると、そのあいだに増減して食い違う。
      take: query.limit + 1,
      select: ADMIN_SELECT,
    });

    const hasMore = rows.length > query.limit;
    const items = (hasMore ? rows.slice(0, query.limit) : rows).map(toAdminRecord);
    const last = items.at(-1);

    return {
      items,
      nextCursor: hasMore && last !== undefined ? { at: last.createdAt, id: last.id } : null,
    };
  }

  /**
   * 状態ごとの件数。
   *
   * ⚠️ **0 件の状態も返す。** `GROUP BY` は 1 件も無い状態を返さないので、
   * そのまま渡すと画面から項目ごと消える。「失敗の欄が無い」と
   * 「失敗が 0 件」は、見た人にとってまったく違う意味になる。
   */
  async countByStatus(): Promise<WalletDeliveryStatusCounts> {
    const grouped = await this.prisma.walletDeliveryOutbox.groupBy({
      by: ['status'],
      _count: { _all: true },
    });

    const counts: Record<WalletDeliveryOutboxStatus, number> = {
      PENDING: 0,
      PROCESSING: 0,
      DELIVERED: 0,
      FAILED: 0,
      DEAD: 0,
    };
    for (const row of grouped) {
      counts[row.status] = row._count._all;
    }
    return counts;
  }

  async findById(id: string): Promise<WalletDeliveryAdminRecord | null> {
    const row = await this.prisma.walletDeliveryOutbox.findUnique({
      where: { id },
      select: ADMIN_SELECT,
    });
    return row === null ? null : toAdminRecord(row);
  }
}

/**
 * 画面へ渡してよい列。
 *
 * ⚠️ **`payload` を足さない。** ここが唯一の門になっている。
 */
const ADMIN_SELECT = {
  id: true,
  eventId: true,
  eventType: true,
  entitlementId: true,
  targetSiteKey: true,
  payloadHash: true,
  status: true,
  attemptCount: true,
  maxAttempts: true,
  nextRetryAt: true,
  lastErrorCode: true,
  lastErrorMessage: true,
  correlationId: true,
  createdAt: true,
  updatedAt: true,
  deliveredAt: true,
} as const satisfies Prisma.WalletDeliveryOutboxSelect;

type AdminRow = Prisma.WalletDeliveryOutboxGetPayload<{ select: typeof ADMIN_SELECT }>;

function whereFor(query: WalletDeliveryAdminQuery): Prisma.WalletDeliveryOutboxWhereInput {
  const where: Prisma.WalletDeliveryOutboxWhereInput = {};

  if (query.statuses.length > 0) {
    where.status = { in: [...query.statuses] };
  }
  if (query.eventId !== null) {
    where.eventId = query.eventId;
  }
  if (query.entitlementId !== null) {
    where.entitlementId = query.entitlementId;
  }

  const cursor = query.cursor;
  if (cursor !== null) {
    /*
      ⚠️ **`createdAt` だけで飛ばさない。** 同じ時刻の行が複数あると、
         その並びの途中から続きを読むことになり、残りが飛ばされる。
         「時刻が古い」または「時刻が同じで行IDが小さい」で続きを取る。
    */
    where.OR = [
      { createdAt: { lt: cursor.at } },
      { createdAt: cursor.at, id: { lt: cursor.id } },
    ];
  }

  return where;
}

function toAdminRecord(row: AdminRow): WalletDeliveryAdminRecord {
  return {
    id: row.id,
    eventId: row.eventId,
    eventType: row.eventType as WalletDeliveryEventType,
    entitlementId: row.entitlementId,
    targetSiteKey: row.targetSiteKey,
    payloadHash: row.payloadHash,
    status: row.status as WalletDeliveryOutboxStatus,
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    nextRetryAt: row.nextRetryAt,
    lastErrorCode: row.lastErrorCode,
    lastErrorMessage: row.lastErrorMessage,
    correlationId: row.correlationId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deliveredAt: row.deliveredAt,
  };
}
