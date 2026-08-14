import { Injectable } from '@nestjs/common';
import {
  createOrder,
  type Artwork,
  type ClockPort,
  type Listing,
  type ListingStatus,
  type OrderDraft,
} from '@sengoku/domain';
import type { CreatedOrder, PurchaseTarget } from '@sengoku/database';
import type { Actor } from '@sengoku/auth';
import { DomainErrorException } from '../common/domain-error.filter';

/**
 * 注文の保存に必要な操作。
 *
 * ⚠️ 具象の Prisma 実装ではなくこれに依存する。
 * 具象に依存すると、コントローラのテストのたびに実 DB が要る。
 */
export interface OrderStore {
  findPurchaseTarget(listingId: string): Promise<PurchaseTarget | null>;
  createWithReservation(input: {
    readonly draft: OrderDraft;
    readonly idempotencyKey: string;
    readonly quantity: number;
  }): Promise<CreatedOrder>;
}

/** 注文の応答。**金額は税込の総額**（`UD-401`: 通貨は JPY 単一）。 */
export interface OrderCreated {
  readonly order_id: string;
  readonly status: string;
  readonly total_amount: number;
  readonly currency: string;
  /** この時刻を過ぎると在庫の仮引当が解放される。 */
  readonly reserved_until: string | null;
}

/**
 * 注文の作成（方針変更 2026-08-14 §8）。
 *
 * ⚠️ **決済事業者を知らない。**
 * 注文は「代金が確定した意思表示」までを表す。決済セッションの作成は
 * 別の層が行い、業務の成功は Webhook で確定する。ここに事業者の概念を
 * 持ち込むと、乗り換えるときに注文ごと書き直しになる（同 §9）。
 */
@Injectable()
export class OrderService {
  constructor(
    private readonly orders: OrderStore,
    private readonly clock: ClockPort,
  ) {}

  async create(input: {
    readonly actor: Actor;
    readonly listingId: string;
    readonly quantity: number;
    readonly idempotencyKey: string;
  }): Promise<OrderCreated> {
    const { actor, listingId, quantity, idempotencyKey } = input;
    if (actor.accountId === null) {
      throw new DomainErrorException('ENTITLEMENT_OWNER_MISMATCH');
    }

    const target = await this.orders.findPurchaseTarget(listingId);
    if (target === null) {
      // ⚠️ 「出品が無い」と「買えない出品」を区別して答えない。
      //    区別すると、未公開の作品の存在を外から探れる。
      throw new DomainErrorException('ARTWORK_NOT_AVAILABLE');
    }

    const draft = createOrder({
      accountId: actor.accountId,
      listing: toListing(target.listing),
      artwork: toArtwork(target.artwork),
      counters: target.artwork.counters,
      quantity,
      now: this.clock.now(),
    });
    if (!draft.ok) {
      throw new DomainErrorException(draft.error.code);
    }

    const order = await this.orders.createWithReservation({
      draft: draft.value,
      idempotencyKey,
      quantity,
    });

    return {
      order_id: order.id,
      status: order.status,
      total_amount: order.totalAmount,
      currency: order.totalCurrency,
      reserved_until: order.reservedUntil?.toISOString() ?? null,
    };
  }
}

/** DB の行をドメインの型へ移す。ここで型を絞り、ドメインに DB を知らせない。 */
function toListing(row: {
  id: string;
  artworkId: string;
  priceAmount: number;
  priceCurrency: string;
  maxQuantityPerOrder: number;
  status: string;
  startsAt: Date | null;
  endsAt: Date | null;
  displayOrder: number;
}): Listing {
  return {
    id: row.id,
    artworkId: row.artworkId,
    price: { amountMinor: row.priceAmount, currency: row.priceCurrency },
    maxQuantityPerOrder: row.maxQuantityPerOrder,
    status: row.status as ListingStatus,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    displayOrder: row.displayOrder,
  };
}

function toArtwork(row: {
  id: string;
  slug: string;
  title: string;
  status: string;
  counters: { maxSupply: number; reservedCount: number; issuedCount: number };
}): Artwork {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: '',
    imageKey: null,
    imageContentType: null,
    imageByteSize: null,
    maxSupply: row.counters.maxSupply,
    reservedCount: row.counters.reservedCount,
    issuedCount: row.counters.issuedCount,
    status: row.status,
  } as unknown as Artwork;
}
