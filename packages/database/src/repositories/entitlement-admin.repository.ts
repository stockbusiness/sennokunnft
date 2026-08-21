import type { PrismaClient } from '../../generated/client';
import { decodeCursor, encodeCursor } from './mappers';

/**
 * 受取権と受取の一覧（実運営 指示書 P0-6）。
 *
 * ⚠️ **買った方の個人情報を持ち出さない。** 出るのは識別子と状態まで。
 * 氏名やメールアドレスの項目を作らなければ、実装側がうっかり載せても
 * 型で落ちる（`UD-503`）。
 *
 * ⚠️ **受取トークンを持ち出さない。** ハッシュであっても出さない。
 * 出す理由が無く、出せば「渡してよいもの」に見える。
 */

/** 一覧の 1 行。 */
export interface EntitlementAdminRow {
  readonly id: string;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly artworkId: string;
  readonly artworkTitle: string;
  readonly serialNo: number;
  readonly status: string;
  readonly walletDeliveryStatus: string;
  /** ⚠️ 共通顧客IDは出す。氏名やメールは出さない。 */
  readonly claimedByCommonUserId: string | null;
  readonly claimedAt: Date | null;
  readonly walletDeliveredAt: Date | null;
  readonly createdAt: Date;
}

export interface EntitlementAdminDetail extends EntitlementAdminRow {
  readonly orderLineId: string;
  readonly accountId: string;
  /** その受取権に対する配送の記録。⚠️ 本文は出さない。 */
  readonly deliveries: readonly {
    readonly id: string;
    readonly eventId: string;
    readonly eventType: string;
    readonly status: string;
    readonly attemptCount: number;
    readonly lastErrorCode: string | null;
    readonly deliveredAt: Date | null;
    readonly createdAt: Date;
  }[];
}

export interface EntitlementAdminQuery {
  readonly status?: string | undefined;
  readonly walletDeliveryStatus?: string | undefined;
  readonly orderId?: string | undefined;
  readonly accountId?: string | undefined;
  readonly limit: number;
  readonly cursor?: string | undefined;
}

export interface EntitlementAdminPage {
  readonly items: readonly EntitlementAdminRow[];
  readonly nextCursor: string | null;
}

export class PrismaEntitlementAdminRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async list(query: EntitlementAdminQuery): Promise<EntitlementAdminPage> {
    const cursor = decodeCursor(query.cursor);
    const rows = await this.prisma.entitlement.findMany({
      where: {
        ...(query.status === undefined ? {} : { status: query.status as never }),
        ...(query.walletDeliveryStatus === undefined
          ? {}
          : { walletDeliveryStatus: query.walletDeliveryStatus }),
        ...(query.orderId === undefined ? {} : { orderId: query.orderId }),
        ...(query.accountId === undefined ? {} : { accountId: query.accountId }),
        ...(cursor === null
          ? {}
          : {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      // ⚠️ 1 件多く取り、次があるかを判定する。件数を数え直さない。
      take: query.limit + 1,
      select: LIST_SELECT,
    });

    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toRow),
      nextCursor:
        rows.length > query.limit && last !== undefined
          ? encodeCursor({ createdAt: last.createdAt, id: last.id })
          : null,
    };
  }

  async findById(id: string): Promise<EntitlementAdminDetail | null> {
    const row = await this.prisma.entitlement.findUnique({
      where: { id },
      select: {
        ...LIST_SELECT,
        orderLineId: true,
        accountId: true,
        walletDeliveries: {
          orderBy: [{ createdAt: 'desc' }],
          // ⚠️ **本文（`payload`）を選ばない。** 個人情報は入らない決まりだが、
          //    画面に出す理由も無い。選ばなければ載せようがない。
          select: {
            id: true,
            eventId: true,
            eventType: true,
            status: true,
            attemptCount: true,
            lastErrorCode: true,
            deliveredAt: true,
            createdAt: true,
          },
        },
      },
    });
    if (row === null) {
      return null;
    }
    return {
      ...toRow(row),
      orderLineId: row.orderLineId,
      accountId: row.accountId,
      deliveries: row.walletDeliveries.map((delivery) => ({
        id: delivery.id,
        eventId: delivery.eventId,
        eventType: delivery.eventType,
        status: delivery.status,
        attemptCount: delivery.attemptCount,
        lastErrorCode: delivery.lastErrorCode,
        deliveredAt: delivery.deliveredAt,
        createdAt: delivery.createdAt,
      })),
    };
  }

  /**
   * その方の、まだ届いていない受取権。
   *
   * ⚠️ **「受け取り済みで未配送」に絞る。** 未受取（`issued`）の分は
   * ウォレットの登録がまだで、送る先が無い。まとめて送ろうとすると
   * 毎回そこで失敗する。
   */
  async listUndeliveredForAccount(accountId: string, limit: number): Promise<readonly string[]> {
    const rows = await this.prisma.entitlement.findMany({
      where: {
        accountId,
        status: 'claimed',
        walletDeliveryStatus: { not: 'delivered' },
      },
      orderBy: [{ createdAt: 'asc' }],
      take: limit,
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }
}

/**
 * 持ち出してよい列。
 *
 * ⚠️ **`claim_token_hash` を入れない。** ハッシュであっても出す理由が無く、
 * 出せば「渡してよいもの」に見える。
 */
const LIST_SELECT = {
  id: true,
  orderId: true,
  artworkId: true,
  serialNo: true,
  status: true,
  walletDeliveryStatus: true,
  claimedByCommonUserId: true,
  claimedAt: true,
  walletDeliveredAt: true,
  createdAt: true,
  order: { select: { orderNumber: true } },
  artwork: { select: { title: true } },
} as const;

function toRow(row: {
  id: string;
  orderId: string;
  artworkId: string;
  serialNo: number;
  status: string;
  walletDeliveryStatus: string;
  claimedByCommonUserId: string | null;
  claimedAt: Date | null;
  walletDeliveredAt: Date | null;
  createdAt: Date;
  order: { orderNumber: string };
  artwork: { title: string };
}): EntitlementAdminRow {
  return {
    id: row.id,
    orderId: row.orderId,
    orderNumber: row.order.orderNumber,
    artworkId: row.artworkId,
    artworkTitle: row.artwork.title,
    serialNo: row.serialNo,
    status: row.status,
    walletDeliveryStatus: row.walletDeliveryStatus,
    claimedByCommonUserId: row.claimedByCommonUserId,
    claimedAt: row.claimedAt,
    walletDeliveredAt: row.walletDeliveredAt,
    createdAt: row.createdAt,
  };
}
