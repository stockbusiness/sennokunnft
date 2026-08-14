import type { OrderDraft, SupplyCounters } from '@sengoku/domain';
import type { PrismaClient } from '../../generated/client';

/** 注文作成に必要な、作品と出品の現在値。 */
export interface PurchaseTarget {
  readonly artwork: {
    readonly id: string;
    readonly slug: string;
    readonly title: string;
    readonly status: string;
    readonly counters: SupplyCounters;
  };
  readonly listing: {
    readonly id: string;
    readonly artworkId: string;
    readonly priceAmount: number;
    readonly priceCurrency: string;
    readonly maxQuantityPerOrder: number;
    readonly status: string;
    readonly startsAt: Date | null;
    readonly endsAt: Date | null;
    readonly displayOrder: number;
  };
}

export interface CreatedOrder {
  readonly id: string;
  readonly status: string;
  readonly totalAmount: number;
  readonly totalCurrency: string;
  readonly reservedUntil: Date | null;
}

/**
 * 注文の永続化。
 *
 * ⚠️ **オーバーセルを防いでいるのはここ。**
 * ドメインの判定だけでは足りない。読み取りと書き込みのあいだに
 * 別の注文が割り込むため、**作品行を `FOR UPDATE` でロックしてから**
 * 数え直して書く。さらに DB の CHECK 制約
 * （`reserved_count + issued_count <= max_supply`）を最終防壁にする。
 *
 * 3 段構えにしてあるのは、どれか 1 つが破れても売り越さないため。
 *  1. ドメインの判定（明らかに通せない要求を手前で弾く）
 *  2. **行ロック**（同時に来た注文を直列化する）
 *  3. CHECK 制約（1 と 2 を迂回した経路も止める）
 */
export class PrismaOrderRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** 出品IDから、注文の判定に要る現在値を引く。 */
  async findPurchaseTarget(listingId: string): Promise<PurchaseTarget | null> {
    const listing = await this.prisma.listing.findUnique({
      where: { id: listingId },
      include: {
        artwork: {
          select: {
            id: true,
            slug: true,
            title: true,
            status: true,
            maxSupply: true,
            reservedCount: true,
            issuedCount: true,
          },
        },
      },
    });
    if (listing === null) {
      return null;
    }
    return {
      artwork: {
        id: listing.artwork.id,
        slug: listing.artwork.slug,
        title: listing.artwork.title,
        status: listing.artwork.status,
        counters: {
          maxSupply: listing.artwork.maxSupply,
          reservedCount: listing.artwork.reservedCount,
          issuedCount: listing.artwork.issuedCount,
        },
      },
      listing: {
        id: listing.id,
        artworkId: listing.artworkId,
        priceAmount: listing.priceAmount,
        priceCurrency: listing.priceCurrency,
        maxQuantityPerOrder: listing.maxQuantityPerOrder,
        status: listing.status,
        startsAt: listing.startsAt,
        endsAt: listing.endsAt,
        displayOrder: listing.displayOrder,
      },
    };
  }

  /**
   * 注文を保存し、在庫を仮引当する。
   *
   * ⚠️ **在庫の数え直しをトランザクションの中で行う。**
   * 呼び出し元が渡してくる `draft.reservedCounters` は、ロックを取る前に
   * 読んだ値から計算されている。ロックを取ったあとの実際の値とは
   * ずれていることがあるので、**ここで読み直して加算する。**
   * 渡された値をそのまま書くと、割り込んだ注文の引当を上書きして消す。
   *
   * @returns 冪等キーが既に使われていれば、そのときの注文をそのまま返す。
   */
  async createWithReservation(input: {
    readonly draft: OrderDraft;
    readonly idempotencyKey: string;
    readonly quantity: number;
  }): Promise<CreatedOrder> {
    const { draft, idempotencyKey, quantity } = input;
    const artworkId = draft.lines[0]?.artworkId;
    if (artworkId === undefined) {
      throw new Error('注文には少なくとも 1 行が必要です');
    }

    return this.prisma.$transaction(async (tx) => {
      // 同じ冪等キーの注文が既にあれば、それを返す（作り直さない）。
      const existing = await tx.order.findUnique({
        where: { accountId_idempotencyKey: { accountId: draft.accountId, idempotencyKey } },
        select: {
          id: true,
          status: true,
          totalAmount: true,
          totalCurrency: true,
          reservedUntil: true,
        },
      });
      if (existing !== null) {
        return existing;
      }

      // ⚠️ **作品行をロックする。** ここが同時購入を直列化する要。
      //    ロックせずに数えると、2 本の注文が同じ残数を見て両方通る。
      await tx.$executeRaw`SELECT id FROM artworks WHERE id = ${artworkId}::uuid FOR UPDATE`;

      // ロック後の実際の値で数え直す。
      await tx.artwork.update({
        where: { id: artworkId },
        data: { reservedCount: { increment: quantity } },
      });

      const order = await tx.order.create({
        data: {
          accountId: draft.accountId,
          totalAmount: draft.total.amountMinor,
          totalCurrency: draft.total.currency,
          idempotencyKey,
          reservedUntil: draft.reservedUntil,
          lines: {
            create: draft.lines.map((line) => ({
              listingId: line.listingId,
              artworkId: line.artworkId,
              artworkTitleSnapshot: line.artworkTitleSnapshot,
              unitPriceAmount: line.unitPrice.amountMinor,
              unitPriceCurrency: line.unitPrice.currency,
              quantity: line.quantity,
            })),
          },
        },
        select: {
          id: true,
          status: true,
          totalAmount: true,
          totalCurrency: true,
          reservedUntil: true,
        },
      });
      return order;
    });
  }
}
