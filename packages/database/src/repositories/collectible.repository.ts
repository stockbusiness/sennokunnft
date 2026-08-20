import type {
  CollectibleListPage,
  CollectibleRepository,
  CollectibleView,
  EntitlementStatus,
  WalletDeliveryStatus,
} from '@sengoku/domain';
import type { PrismaClient } from '../../generated/client';
import { decodeCursor, encodeCursor } from './mappers';

/** 1 度に返す最大件数。⚠️ 呼び出し元の指定より大きくしない。 */
const MAX_PAGE_SIZE = 50;

/**
 * 買った方が自分の受け取ったものを見る口（P0-3）。
 *
 * ⚠️ **絞り込みをこの中で必ず行う。** 呼び出し元が `where` を組み立てる形に
 * すると、絞り忘れがそのまま全員分の流出になる。アカウントIDは引数で受け取り、
 * ここで必ず条件へ入れる。
 */
export class PrismaCollectibleRepository implements CollectibleRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listForAccount(input: {
    readonly accountId: string;
    readonly limit: number;
    readonly cursor?: string | undefined;
  }): Promise<CollectibleListPage> {
    const limit = Math.min(Math.max(input.limit, 1), MAX_PAGE_SIZE);
    const cursor = decodeCursor(input.cursor);

    const rows = await this.prisma.entitlement.findMany({
      where: {
        // ⚠️ ここが唯一の絞り込み。外して呼べる形にしない。
        accountId: input.accountId,
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
      take: limit + 1,
      select: {
        id: true,
        artworkId: true,
        serialNo: true,
        status: true,
        walletDeliveryStatus: true,
        createdAt: true,
        orderId: true,
        order: { select: { orderNumber: true } },
        /*
          ⚠️ **作品名と出品者名は注文明細（注文時点の値）から取る。** 作品の
             マスタを引き直すと、改題・改名のたびにお買い上げの記録の見え方が
             変わる。お客さまが受け取った控えと画面が食い違う。
        */
        orderLine: { select: { artworkTitleSnapshot: true, creatorNameSnapshot: true } },
        // ⚠️ 画像だけは現在の作品のもの。スナップショットの列が無い。
        artwork: { select: { slug: true, imageKey: true } },
      },
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);

    const items: CollectibleView[] = page.map((row) => ({
      entitlementId: row.id,
      artworkId: row.artworkId,
      artworkSlug: row.artwork.slug,
      artworkTitle: row.orderLine.artworkTitleSnapshot,
      creatorName: row.orderLine.creatorNameSnapshot,
      imageKey: row.artwork.imageKey,
      serialNo: row.serialNo,
      acquiredAt: row.createdAt,
      status: row.status as EntitlementStatus,
      deliveryStatus: row.walletDeliveryStatus as WalletDeliveryStatus,
      orderNumber: row.order.orderNumber,
      orderId: row.orderId,
    }));

    return {
      items,
      nextCursor:
        hasMore && last !== undefined
          ? encodeCursor({ createdAt: last.createdAt, id: last.id })
          : null,
    };
  }
}
