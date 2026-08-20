import {
  domainError,
  err,
  ok,
  reserveSupply,
  type CreateOrderCommand,
  type CreateOrderOutcome,
  type DomainError,
  type OrderListPage,
  type OrderListQuery,
  type OrderNoteEntry,
  type OrderNoteRepository,
  type OrderRepository,
  type OrderSearchCriteria,
  type OrderView,
  type ReleasedReservation,
  type Result,
} from '@sengoku/domain';
import { Prisma, type PrismaClient } from '../../generated/client';
import { decodeCursor, encodeCursor, toOrderView, ORDER_VIEW_INCLUDE } from './mappers';

/** 1 回の取得件数の上限。呼び出し側が大きな値を渡しても、ここで頭打ちにする。 */
const MAX_PAGE_SIZE = 100;

/** 1 回の解放で扱う件数の上限。全件を 1 トランザクションで抱え込ませない。 */
const MAX_RELEASE_BATCH = 500;

interface ClaimedReservationRow {
  readonly id: string;
  readonly order_id: string;
  readonly artwork_id: string;
  readonly quantity: number;
}

/**
 * 注文リポジトリの Prisma 実装（決済 Phase P0・P1）。
 *
 * ⚠️ **オーバーセルを止める最後の砦がここにある。** 3 段構えで守る:
 *   1. ドメインの `reserveSupply`（明らかに通らない要求を手前で弾く）
 *   2. 作品行の `FOR UPDATE`（同時に走った 2 本を直列化する）
 *   3. DB の CHECK 制約 `artworks_supply_within_max`（1・2 が抜けても超えさせない）
 * どれか 1 つでも外すと、最後の 1 枠が 2 人に売れる。
 */
export class PrismaOrderRepository implements OrderRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createWithReservation(
    command: CreateOrderCommand,
  ): Promise<Result<CreateOrderOutcome, DomainError>> {
    return this.prisma.$transaction(async (tx) => {
      // 1. 作品行をロックする。
      //    ⚠️ 冪等キーの確認より先にロックを取る。順番を入れ替えると、
      //    「既存なし」と判断した 2 本が同時にロック待ちへ入り、
      //    どちらも新規作成へ進む。
      //    ⚠️ 生 SQL の戻り値は列名のままなので、id しか取らない。
      //    値は Prisma 経由で読む。
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "artworks" WHERE id = ${command.item.artworkId}::uuid FOR UPDATE
      `;
      if (locked.length === 0) {
        return err(domainError('ARTWORK_NOT_AVAILABLE', 'artwork not found'));
      }

      // 2. 冪等キー。⚠️ **同じトランザクションの中で見る。**
      //    外で先に見ると、見てから作るまでのあいだに割り込まれる。
      const existing = await tx.order.findUnique({
        where: {
          accountId_idempotencyKey: {
            accountId: command.accountId,
            idempotencyKey: command.idempotencyKey,
          },
        },
        include: ORDER_VIEW_INCLUDE,
      });
      if (existing !== null) {
        const line = existing.lines[0];
        // ⚠️ 同じキーで違う商品が来たら、前の注文を返さない。
        //    返すと、買ったつもりのない物を買わされる（指示書 §4.5）。
        if (line === undefined || line.listingId !== command.item.listingId) {
          return ok<CreateOrderOutcome>({ kind: 'conflict' });
        }
        return ok<CreateOrderOutcome>({ kind: 'reused', order: toOrderView(existing) });
      }

      // 3. ロック後のカウンタで在庫を**もう一度**判定する。
      //    手前の判定はロックの前に行われているため、そのままでは信用できない。
      const artwork = await tx.artwork.findUniqueOrThrow({
        where: { id: command.item.artworkId },
        select: { maxSupply: true, reservedCount: true, issuedCount: true },
      });
      const reserved = reserveSupply(artwork, command.quantity);
      if (!reserved.ok) {
        return reserved;
      }

      // 4. 注文・明細・仮引当を作り、作品のカウンタを進める。
      await tx.order.create({
        data: {
          id: command.orderId,
          orderNumber: command.orderNumber,
          accountId: command.accountId,
          commonUserId: command.commonUserId,
          creatorAccountId: command.creatorAccountId,
          status: command.orderStatus,
          paymentStatus: command.paymentStatus,
          fulfillmentStatus: command.fulfillmentStatus,
          refundStatus: command.refundStatus,
          subtotalAmount: command.amounts.subtotalAmount,
          discountAmount: command.amounts.discountAmount,
          totalAmount: command.amounts.totalAmount,
          totalCurrency: command.currency,
          platformFeeRateBps: command.amounts.platformFeeRateBps,
          platformFeeAmount: command.amounts.platformFeeAmount,
          creatorAmount: command.amounts.creatorAmount,
          idempotencyKey: command.idempotencyKey,
          // ⚠️ 注文時点の規約の版（`UD-126`）。同意の記録ではなく
          //    「何が表示されていたか」の記録。
          termsVersionId: command.termsVersionId,
          termsVersion: command.termsVersion,
          reservedUntil: command.reservationExpiresAt,
          createdAt: command.now,
          updatedAt: command.now,
        },
      });
      await tx.orderLine.create({
        data: {
          id: command.item.id,
          orderId: command.orderId,
          listingId: command.item.listingId,
          artworkId: command.item.artworkId,
          creatorAccountId: command.item.creatorAccountId,
          artworkTitleSnapshot: command.item.titleSnapshot,
          // ⚠️ 注文時点の表示名。改名しても過去のご注文は動かない。
          creatorNameSnapshot: command.item.creatorNameSnapshot,
          unitPriceAmount: command.item.unitPriceAmount,
          unitPriceCurrency: command.item.unitPriceCurrency,
          quantity: command.item.quantity,
          totalAmount: command.item.totalAmount,
          createdAt: command.now,
        },
      });
      await tx.inventoryReservation.create({
        data: {
          id: command.reservationId,
          orderId: command.orderId,
          listingId: command.item.listingId,
          artworkId: command.item.artworkId,
          quantity: command.quantity,
          status: 'reserved',
          expiresAt: command.reservationExpiresAt,
          createdAt: command.now,
          updatedAt: command.now,
        },
      });
      await tx.artwork.update({
        where: { id: command.item.artworkId },
        data: { reservedCount: reserved.value.reservedCount, updatedAt: command.now },
      });

      const created = await tx.order.findUniqueOrThrow({
        where: { id: command.orderId },
        include: ORDER_VIEW_INCLUDE,
      });
      return ok<CreateOrderOutcome>({ kind: 'created', order: toOrderView(created) });
    });
  }

  async findById(orderId: string): Promise<OrderView | null> {
    const row = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: ORDER_VIEW_INCLUDE,
    });
    return row === null ? null : toOrderView(row);
  }

  async list(query: OrderListQuery): Promise<OrderListPage> {
    const limit = Math.min(Math.max(query.limit, 1), MAX_PAGE_SIZE);
    const cursor = decodeCursor(query.cursor);
    const filters = {
      ...(query.accountId === undefined ? {} : { accountId: query.accountId }),
      ...searchFilters(query.criteria),
    };

    const rows = await this.prisma.order.findMany({
      where: {
        ...filters,
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
      include: ORDER_VIEW_INCLUDE,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);
    return {
      items: page.map(toOrderView),
      nextCursor:
        hasMore && last !== undefined
          ? encodeCursor({ createdAt: last.createdAt, id: last.id })
          : null,
    };
  }

  /**
   * 期限切れの仮引当を解放する。
   *
   * ⚠️ **数えてから戻さない。** 条件付き UPDATE で 1 件ずつ確保（claim）し、
   * 確保できた行だけ在庫を戻す。件数を先に数えてまとめて戻すと、
   * 同時に走った 2 本が同じ行を 2 回戻し、**在庫が増える**。
   *
   * ⚠️ 確保と在庫戻しを同一トランザクションに置く。分けると、
   * 確保したあと落ちた行が `released` のまま在庫だけ戻らない。
   */
  async releaseExpiredReservations(
    now: Date,
    limit: number,
  ): Promise<readonly ReleasedReservation[]> {
    const batch = Math.min(Math.max(limit, 1), MAX_RELEASE_BATCH);
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.$queryRaw<readonly ClaimedReservationRow[]>(Prisma.sql`
        UPDATE "inventory_reservations"
           SET "status" = 'released',
               "released_at" = ${now},
               "updated_at" = ${now}
         WHERE "id" IN (
           SELECT "id"
             FROM "inventory_reservations"
            WHERE "status" = 'reserved'
              AND "expires_at" <= ${now}
            ORDER BY "expires_at"
              FOR UPDATE SKIP LOCKED
            LIMIT ${batch}
         )
        RETURNING "id", "order_id", "artwork_id", "quantity"
      `);
      if (claimed.length === 0) {
        return [];
      }

      // ⚠️ 作品IDの順に並べてから触る。順番をそろえないと、
      //    同時に走ったバッチが互いのロックを待ち合ってデッドロックになる。
      const sorted = [...claimed].sort((a, b) => (a.artwork_id < b.artwork_id ? -1 : 1));
      for (const row of sorted) {
        await tx.artwork.update({
          where: { id: row.artwork_id },
          data: { reservedCount: { decrement: row.quantity }, updatedAt: now },
        });
        // ⚠️ 決済が進んでいる注文を期限切れにしない。
        //    条件に状態を含めることで、Webhook と競っても上書きしない。
        await tx.order.updateMany({
          where: {
            id: row.order_id,
            status: { in: ['pending', 'checkout_created'] },
          },
          data: { status: 'expired', updatedAt: now },
        });
      }

      return claimed.map((row) => ({
        reservationId: row.id,
        orderId: row.order_id,
        artworkId: row.artwork_id,
        quantity: row.quantity,
      }));
    });
  }
}

/**
 * 検索条件を Prisma の絞り込みへ移す（`UD-121`）。
 *
 * ⚠️ **条件が無いものは `where` へ入れない。** `undefined` を並べても
 * 動くが、条件の有無が読み取れなくなる。
 */
function searchFilters(criteria: OrderSearchCriteria | undefined): Prisma.OrderWhereInput {
  if (criteria === undefined) {
    return {};
  }

  const createdAt =
    criteria.createdFrom === null && criteria.createdTo === null
      ? undefined
      : {
          ...(criteria.createdFrom === null ? {} : { gte: criteria.createdFrom }),
          ...(criteria.createdTo === null ? {} : { lte: criteria.createdTo }),
        };

  const totalAmount =
    criteria.minTotalAmount === null && criteria.maxTotalAmount === null
      ? undefined
      : {
          ...(criteria.minTotalAmount === null ? {} : { gte: criteria.minTotalAmount }),
          ...(criteria.maxTotalAmount === null ? {} : { lte: criteria.maxTotalAmount }),
        };

  return {
    ...(criteria.status === null ? {} : { status: criteria.status }),
    ...(criteria.paymentStatus === null ? {} : { paymentStatus: criteria.paymentStatus }),
    ...(criteria.orderNumber === null
      ? {}
      : criteria.orderNumber.kind === 'exact'
        ? { orderNumber: criteria.orderNumber.value }
        : // ⚠️ 末尾一致は索引が効かない。件数が増えたら `pg_trgm` へ
          //    （マイグレーション `20260820090000_order_support` の注記）。
          { orderNumber: { endsWith: criteria.orderNumber.value } }),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(totalAmount === undefined ? {} : { totalAmount }),
    ...(criteria.artworkTitle === null
      ? {}
      : {
          // ⚠️ **注文時点の名前で引く。** マスタ（`artworks.title`）を
          //    引き直すと、あとで改題された作品が検索から消える。
          lines: {
            some: {
              artworkTitleSnapshot: { contains: criteria.artworkTitle, mode: 'insensitive' },
            },
          },
        }),
    ...(criteria.emailHash === null
      ? {}
      : // ⚠️ 平文ではなく照合値で引く（`UD-503`）。
        { account: { emailHash: criteria.emailHash } }),
  };
}

/**
 * 対応メモの Prisma 実装（`UD-121`）。
 *
 * ⚠️ **更新と削除のメソッドを足さない。** 足した瞬間に「間違えたから
 * 消しておいて」が始まる。訂正は新しいメモで行う。
 */
export class PrismaOrderNoteRepository implements OrderNoteRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listByOrder(orderId: string): Promise<readonly OrderNoteEntry[]> {
    const rows = await this.prisma.orderNote.findMany({
      where: { orderId },
      // ⚠️ 古い順。経過は「起きた順」に読むもの。
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toNoteEntry);
  }

  async append(input: {
    readonly id: string;
    readonly orderId: string;
    readonly authorAccountId: string;
    readonly body: string;
    readonly now: Date;
  }): Promise<OrderNoteEntry> {
    const row = await this.prisma.orderNote.create({
      data: {
        id: input.id,
        orderId: input.orderId,
        authorAccountId: input.authorAccountId,
        body: input.body,
        createdAt: input.now,
      },
    });
    return toNoteEntry(row);
  }
}

function toNoteEntry(row: {
  id: string;
  authorAccountId: string;
  body: string;
  createdAt: Date;
}): OrderNoteEntry {
  return {
    id: row.id,
    authorAccountId: row.authorAccountId,
    body: row.body,
    createdAt: row.createdAt,
  };
}
