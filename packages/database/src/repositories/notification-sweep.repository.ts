import type { PrismaClient } from '../../generated/client';

/**
 * 「届いた」「届かないまま止まっている」を DB から数え上げる（P0-4）。
 *
 * ⚠️ **キューを別に作らない。** どちらの出来事も配送ワーカーの側で起きるが、
 * そこから知らせを積む口を生やすと、ワーカーが落ちていた時間ぶんが
 * 永久に抜ける。**いまの状態から導ける**ことは、状態から導く。
 * （受取権の発行（P0-1）で同じ考え方を採った。）
 *
 * ⚠️ **何度走らせても増えない。** 積む側が
 * `UNIQUE(event_type, subject_type, subject_id)` で受けるため。
 */

/** 知らせを積むのに要る材料。⚠️ メールアドレスは含まない（`UD-503`）。 */
export interface NotifiableEntitlement {
  readonly entitlementId: string;
  readonly accountId: string;
  readonly orderNumber: string;
  readonly artworkTitle: string;
  readonly serialNo: number;
}

export class PrismaNotificationSweepRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * お受け取りが完了したのに、まだ知らせていない受取権。
   *
   * ⚠️ **`wallet_delivery_status = 'delivered'` を条件にする。** 行列へ
   * 載せた時点ではない。載せただけで「お届けしました」と送ると、
   * 相手側で失敗したときに嘘になる。
   */
  async listDeliveredWithoutNotice(limit: number): Promise<readonly NotifiableEntitlement[]> {
    const rows = await this.prisma.entitlement.findMany({
      where: {
        status: 'claimed',
        walletDeliveryStatus: 'delivered',
      },
      select: SWEEP_SELECT,
      orderBy: [{ walletDeliveredAt: 'asc' }],
      take: limit,
    });
    return this.excludeNotified(rows, 'entitlement.delivered', limit);
  }

  /**
   * 送信を打ち切ったまま止まっている受取権。
   *
   * ⚠️ **`DEAD` だけを拾う。** `FAILED` はまだ人が直せば送れる状態で、
   * その段階で「遅れております」と送ると、直後に届いて食い違う。
   */
  async listStalledWithoutNotice(limit: number): Promise<readonly NotifiableEntitlement[]> {
    const rows = await this.prisma.entitlement.findMany({
      where: {
        status: 'claimed',
        walletDeliveryStatus: { not: 'delivered' },
        walletDeliveries: {
          some: { eventType: 'entitlement.granted', status: 'DEAD' },
        },
      },
      select: SWEEP_SELECT,
      orderBy: [{ updatedAt: 'asc' }],
      take: limit,
    });
    return this.excludeNotified(rows, 'wallet.delivery_stalled', limit);
  }

  /** すでに積んである分を落とす。⚠️ 積む側も UNIQUE で受けるので二重の守り。 */
  private async excludeNotified(
    rows: readonly SweepRow[],
    eventType: string,
    limit: number,
  ): Promise<readonly NotifiableEntitlement[]> {
    if (rows.length === 0) {
      return [];
    }
    const notified = await this.prisma.notificationDelivery.findMany({
      where: {
        eventType,
        subjectType: 'entitlement',
        subjectId: { in: rows.map((row) => row.id) },
      },
      select: { subjectId: true },
    });
    const known = new Set(notified.map((row) => row.subjectId));
    return rows
      .filter((row) => !known.has(row.id))
      .slice(0, limit)
      .map((row) => ({
        entitlementId: row.id,
        accountId: row.accountId,
        orderNumber: row.order.orderNumber,
        artworkTitle: row.artwork.title,
        serialNo: row.serialNo,
      }));
  }
}

const SWEEP_SELECT = {
  id: true,
  accountId: true,
  serialNo: true,
  order: { select: { orderNumber: true } },
  artwork: { select: { title: true } },
} as const;

interface SweepRow {
  readonly id: string;
  readonly accountId: string;
  readonly serialNo: number;
  readonly order: { readonly orderNumber: string };
  readonly artwork: { readonly title: string };
}
