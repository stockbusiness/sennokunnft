import { Injectable } from '@nestjs/common';
import type {
  AdminOrderDetail,
  AdminOrderView,
  OrderView as OrderViewResponse,
} from '@sengoku/contracts';
import {
  createOrder,
  generateOrderNumber,
  type ArtworkRepository,
  type AuditLogPort,
  type ClockPort,
  type CommonUserLinkRepository,
  type CreateOrderCommand,
  type IdGeneratorPort,
  type ListingRepository,
  type OrderRepository,
  type OrderStatus,
  type OrderView,
  type PaymentRepository,
  type RandomPort,
  type ReleasedReservation,
} from '@sengoku/domain';
import { DomainErrorException } from '../common/domain-error.filter';

export interface OrderServiceConfig {
  /**
   * 注文時点の手数料率（bps）を引く。
   *
   * ⚠️ **設定から来る。ブラウザからは来ない。**
   * ⚠️ **呼び出しのたびに引く。** 管理画面で率を変えたら、次の注文から
   * 効いてほしい。起動時に読んだ値を持ち回ると、変えたのに効かない。
   * 引いた値は注文へスナップショットされるので、**過去の注文は動かない。**
   */
  readonly resolvePlatformFeeRateBps: () => Promise<number>;
  readonly reservationMinutes: number;
}

/** 冪等キーの識別表示に使う長さ。⚠️ 全体を画面へ出さない。 */
const IDEMPOTENCY_KEY_PREFIX_LENGTH = 8;

/**
 * 注文の作成と読み出し（決済 Phase P0・P1）。
 *
 * ⚠️ **ブラウザから金額を受け取らない**（指示書 §4.2）。受け取るのは
 * 「どれを買うか」と「同じ操作かどうか」だけ。価格・通貨・出品者・
 * 手数料率は、ここで DB と設定から引く。
 *
 * ⚠️ **決済を進めない。** 注文は「買う意思が固まった」までを表す。
 * `paid` にできるのは決済事業者の Webhook だけで、この層には
 * その経路を作らない（Phase P2）。
 */
@Injectable()
export class OrderService {
  constructor(
    private readonly orders: OrderRepository,
    private readonly listings: ListingRepository,
    private readonly artworks: ArtworkRepository,
    /**
     * 共通顧客IDの解決状況（代理店システムが発行する）。
     *
     * ⚠️ **ブラウザから受け取らない**（指示書 §4.2）。ここで DB から引く。
     * ⚠️ **未解決でも注文を止めない。** 解決は外部システム次第で、
     * 待たせると「買えない」だけが利用者に残る。列は NULL を許してある。
     */
    private readonly commonUserLinks: CommonUserLinkRepository,
    /**
     * 決済の記録（決済 Phase P2）。
     *
     * ⚠️ **無い環境では `null`。** 「渡すが中で落ちる」形にすると、
     * 決済を繋いでいない配備で運営の詳細画面が 500 になる。
     */
    private readonly payments: PaymentRepository | null,
    private readonly clock: ClockPort,
    private readonly ids: IdGeneratorPort,
    private readonly random: RandomPort,
    private readonly audit: AuditLogPort,
    private readonly config: OrderServiceConfig,
  ) {}

  async create(input: {
    readonly accountId: string;
    readonly listingId: string;
    readonly idempotencyKey: string;
  }): Promise<{ readonly order: OrderViewResponse; readonly reused: boolean }> {
    const now = this.clock.now();

    // ⚠️ 解決済みのときだけ写す。`PENDING` の途中経過を注文へ焼き付けると、
    //    あとで正しい値に解決されても、この注文だけ古いまま残る。
    const link = await this.commonUserLinks.findByAccountId(input.accountId);
    const commonUserId = link?.status === 'RESOLVED' ? link.commonUserId : null;

    const listing = await this.listings.findById(input.listingId);
    if (listing === null) {
      // ⚠️ 「下書きの出品がある」と「そんな出品は無い」を区別しない。
      //    区別すると、未公開の作品の存在を総当たりで探れる。
      throw new DomainErrorException('ARTWORK_NOT_AVAILABLE');
    }
    const artwork = await this.artworks.findById(listing.artworkId);
    if (artwork === null) {
      throw new DomainErrorException('ARTWORK_NOT_AVAILABLE');
    }

    // 判定と金額の確定はドメインで行う。
    // ⚠️ ここで在庫が通っても、まだ売れると決まっていない。
    //    最終判定はリポジトリが作品行をロックしてから行う。
    const draft = createOrder({
      accountId: input.accountId,
      commonUserId,
      listing,
      artwork,
      creatorAccountId: artwork.creatorAccountId,
      counters: artwork,
      quantity: 1,
      platformFeeRateBps: await this.config.resolvePlatformFeeRateBps(),
      now,
      reservationMinutes: this.config.reservationMinutes,
    });
    if (!draft.ok) {
      throw new DomainErrorException(draft.error.code);
    }

    const item = draft.value.items[0];
    if (item === undefined) {
      // 1 注文 1 明細。ドメインが必ず 1 本作るので、ここへは来ない。
      throw new DomainErrorException('INVALID_QUANTITY');
    }

    const command: CreateOrderCommand = {
      orderId: this.ids.generate(),
      orderNumber: generateOrderNumber(now, this.random),
      accountId: draft.value.accountId,
      commonUserId: draft.value.commonUserId,
      creatorAccountId: draft.value.creatorAccountId,
      idempotencyKey: input.idempotencyKey,
      currency: draft.value.currency,
      amounts: draft.value.amounts,
      orderStatus: draft.value.orderStatus,
      paymentStatus: draft.value.paymentStatus,
      fulfillmentStatus: draft.value.fulfillmentStatus,
      refundStatus: draft.value.refundStatus,
      item: {
        id: this.ids.generate(),
        listingId: item.listingId,
        artworkId: item.artworkId,
        creatorAccountId: item.creatorAccountId,
        titleSnapshot: item.titleSnapshot,
        unitPriceAmount: item.unitPrice.amountMinor,
        unitPriceCurrency: item.unitPrice.currency,
        quantity: item.quantity,
        totalAmount: item.totalAmount,
      },
      reservationId: this.ids.generate(),
      reservationExpiresAt: draft.value.reservationExpiresAt,
      quantity: item.quantity,
      now,
    };

    const outcome = await this.orders.createWithReservation(command);
    if (!outcome.ok) {
      throw new DomainErrorException(outcome.error.code);
    }
    if (outcome.value.kind === 'conflict') {
      // ⚠️ 前の注文を返さない。同じキーで別の商品が来たときに前のものを
      //    返すと、買ったつもりのない物を買わされる（指示書 §4.5）。
      await this.audit.record({
        actorAccountId: input.accountId,
        action: 'order.idempotency_conflict',
        targetType: 'order',
        targetId: null,
        summary: {
          // ⚠️ キーそのものを残さない。突き合わせに要るのは先頭だけ。
          idempotencyKeyPrefix: input.idempotencyKey.slice(0, IDEMPOTENCY_KEY_PREFIX_LENGTH),
        },
      });
      throw new DomainErrorException('IDEMPOTENCY_CONFLICT');
    }

    const reused = outcome.value.kind === 'reused';
    await this.audit.record({
      actorAccountId: input.accountId,
      action: reused ? 'order.idempotency_reused' : 'order.created',
      targetType: 'order',
      targetId: outcome.value.order.id,
      summary: {
        orderNumber: outcome.value.order.orderNumber,
        listingId: item.listingId,
        quantity: item.quantity,
        // ⚠️ 金額は残してよい。個人を特定しない、あとで必ず要る事実。
        totalAmount: outcome.value.order.totalAmount,
        currency: outcome.value.order.currency,
        idempotencyKeyPrefix: input.idempotencyKey.slice(0, IDEMPOTENCY_KEY_PREFIX_LENGTH),
        ...(reused ? {} : { reservationExpiresAt: command.reservationExpiresAt.toISOString() }),
      },
    });

    return { order: toBuyerView(outcome.value.order), reused };
  }

  /**
   * 購入者が自分の注文を見る。
   *
   * ⚠️ **持ち主の照合をここで行う。** 他人の注文を ID 直打ちで開けると、
   * 何をいくらで買ったかが漏れる。見つからない場合と他人の場合を
   * 同じ `null` にして、注文IDの存在を探れないようにする。
   */
  async findForBuyer(orderId: string, accountId: string): Promise<OrderViewResponse | null> {
    const order = await this.orders.findById(orderId);
    if (order === null || order.accountId !== accountId) {
      return null;
    }
    return toBuyerView(order);
  }

  async findForAdmin(orderId: string): Promise<AdminOrderDetail | null> {
    const order = await this.orders.findById(orderId);
    if (order === null) {
      return null;
    }

    /*
      決済の追跡（指示書 §13）。
      ⚠️ **決済の口が無い環境では、この節ごと出さない。** 空の表を出すと、
         「まだ来ていない」のか「そもそも繋がっていない」のか分からない。
    */
    if (this.payments === null) {
      return toAdminView(order);
    }

    const [attempts, webhooks] = await Promise.all([
      this.payments.listAttempts(order.id),
      this.payments.listWebhookReceipts(order.id),
    ]);

    const succeeded = attempts.find((attempt) => attempt.status === 'succeeded');
    return {
      ...toAdminView(order),
      payments: {
        attempts: attempts.map((attempt) => ({
          id: attempt.id,
          provider: attempt.provider,
          status: attempt.status,
          // ⚠️ 識別子は出すが、支払いページの URL は出さない。
          //    URL を持つ人は誰でもその注文を支払える。
          sessionRef: attempt.sessionRef,
          paymentRef: attempt.paymentRef,
          chargeRef: attempt.chargeRef,
          amount: attempt.amount,
          currency: attempt.currency,
          expiresAt: attempt.expiresAt?.toISOString() ?? null,
          paidAt: attempt.paidAt?.toISOString() ?? null,
          failureCode: attempt.failureCode,
          createdAt: attempt.createdAt.toISOString(),
        })),
        webhooks: webhooks.map((receipt) => ({
          eventType: receipt.eventType,
          status: receipt.status,
          livemode: receipt.livemode,
          apiVersion: receipt.apiVersion,
          attemptCount: receipt.attemptCount,
          receivedAt: receipt.receivedAt.toISOString(),
          processedAt: receipt.processedAt?.toISOString() ?? null,
          lastErrorCode: receipt.lastErrorCode,
        })),
        // ⚠️ 受領がまだ無いときは「一致しない」ではなく「分からない」。
        amountMatches: succeeded === undefined ? null : succeeded.amount === order.totalAmount,
      },
    };
  }

  async listForAdmin(query: {
    readonly limit: number;
    readonly cursor?: string | undefined;
    readonly status?: OrderStatus | undefined;
  }): Promise<{ readonly items: readonly AdminOrderView[]; readonly nextCursor: string | null }> {
    const page = await this.orders.list(query);
    return { items: page.items.map(toAdminView), nextCursor: page.nextCursor };
  }

  /**
   * 期限切れの仮引当を解放する（指示書 §4.4）。
   *
   * ⚠️ **再実行しても二重に解放しない。** 条件付き更新で 1 件ずつ確保する
   * 実装をリポジトリが持つ。ここは件数を数え、証跡を残すだけ。
   */
  async releaseExpiredReservations(limit: number): Promise<readonly ReleasedReservation[]> {
    const now = this.clock.now();
    const released = await this.orders.releaseExpiredReservations(now, limit);
    if (released.length === 0) {
      // ⚠️ 何もしなかった実行の証跡は残さない。毎分の空振りで
      //    監査ログが埋まると、本当に見たい行が探せなくなる。
      return released;
    }
    await this.audit.record({
      // システムによる自動処理。人の操作ではない。
      actorAccountId: null,
      action: 'order.reservation_released',
      targetType: 'order',
      targetId: null,
      summary: {
        releasedCount: released.length,
        // ⚠️ 追跡に要るのは注文ID。購入者は載せない。
        orderIds: released.map((entry) => entry.orderId),
      },
    });
    return released;
  }
}

function toBuyerView(order: OrderView): OrderViewResponse {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    paymentStatus: order.paymentStatus,
    fulfillmentStatus: order.fulfillmentStatus,
    currency: order.currency,
    subtotalAmount: order.subtotalAmount,
    discountAmount: order.discountAmount,
    totalAmount: order.totalAmount,
    reservationExpiresAt: order.reservationExpiresAt?.toISOString() ?? null,
    createdAt: order.createdAt.toISOString(),
    item:
      order.item === null
        ? null
        : {
            artworkId: order.item.artworkId,
            listingId: order.item.listingId,
            titleSnapshot: order.item.titleSnapshot,
            unitPriceAmount: order.item.unitPriceAmount,
            currency: order.item.unitPriceCurrency,
            quantity: order.item.quantity,
            totalAmount: order.item.totalAmount,
          },
  };
}

function toAdminView(order: OrderView): AdminOrderView {
  return {
    ...toBuyerView(order),
    refundStatus: order.refundStatus,
    platformFeeRateBps: order.platformFeeRateBps,
    platformFeeAmount: order.platformFeeAmount,
    creatorAmount: order.creatorAmount,
    creatorAccountId: order.creatorAccountId,
    accountId: order.accountId,
    paidAt: order.paidAt?.toISOString() ?? null,
    reservation:
      order.reservation === null
        ? null
        : {
            status: order.reservation.status,
            quantity: order.reservation.quantity,
            expiresAt: order.reservation.expiresAt.toISOString(),
            consumedAt: order.reservation.consumedAt?.toISOString() ?? null,
            releasedAt: order.reservation.releasedAt?.toISOString() ?? null,
          },
    hasPayment: order.hasPayment,
    entitlementCount: order.entitlementCount,
    idempotencyKeyPrefix: order.idempotencyKeyPrefix,
  };
}
