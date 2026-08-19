import type { DomainError } from '../shared/errors';
import type { Result } from '../shared/result';
import type {
  FulfillmentStatus,
  OrderPaymentStatus,
  OrderStatus,
  RefundStatus,
} from '../order/order-status';
import type { ReservationStatus } from '../order/reservation';
import type { OrderAmounts } from '../order/pricing';

/**
 * 注文の永続化境界（決済 Phase P0・P1）。
 *
 * ⚠️ **在庫の排他はここでしか成立しない。** ドメインの `createOrder` は
 * 「その瞬間のカウンタで通るか」しか見られない。読み取りと書き込みの
 * あいだに割り込みが入るため、**作品行のロックと DB の CHECK 制約**が
 * 最後の砦になる。実装は必ず同一トランザクションで
 * 「ロック → 冪等キー確認 → 在庫再判定 → 注文・明細・予約の作成 →
 * 作品カウンタの更新」を行うこと。
 *
 * ⚠️ **決済事業者を知らない。** Stripe の語彙をこの境界へ持ち込まない。
 */

/** 保存する注文明細。⚠️ すべて注文時点のスナップショット。 */
export interface OrderItemCommand {
  readonly id: string;
  readonly listingId: string;
  readonly artworkId: string;
  readonly creatorAccountId: string;
  readonly titleSnapshot: string;
  readonly unitPriceAmount: number;
  readonly unitPriceCurrency: string;
  readonly quantity: number;
  readonly totalAmount: number;
}

/**
 * 注文を 1 件作るための、確定済みの値。
 *
 * ⚠️ **ここに「価格を引く」余地を残さない。** 値はすべて呼び出し側が
 * DB と設定から決めたうえで渡す。実装が listing を読み直して価格を
 * 埋めると、注文時点のスナップショットという原則が崩れる。
 */
export interface CreateOrderCommand {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly accountId: string;
  readonly commonUserId: string | null;
  readonly creatorAccountId: string;
  readonly idempotencyKey: string;
  readonly currency: string;
  readonly amounts: OrderAmounts;
  readonly orderStatus: OrderStatus;
  readonly paymentStatus: OrderPaymentStatus;
  readonly fulfillmentStatus: FulfillmentStatus;
  readonly refundStatus: RefundStatus;
  readonly item: OrderItemCommand;
  readonly reservationId: string;
  readonly reservationExpiresAt: Date;
  /** 要求数量。⚠️ 実装はロック後のカウンタで**もう一度**在庫を判定する。 */
  readonly quantity: number;
  readonly now: Date;
}

/** 画面と API が読む注文。⚠️ 個人を特定する値はここに載せない。 */
export interface OrderView {
  readonly id: string;
  readonly orderNumber: string;
  readonly accountId: string;
  readonly creatorAccountId: string;
  readonly status: OrderStatus;
  readonly paymentStatus: OrderPaymentStatus;
  readonly fulfillmentStatus: FulfillmentStatus;
  readonly refundStatus: RefundStatus;
  readonly currency: string;
  readonly subtotalAmount: number;
  readonly discountAmount: number;
  readonly totalAmount: number;
  readonly platformFeeRateBps: number;
  readonly platformFeeAmount: number;
  readonly creatorAmount: number;
  readonly reservationExpiresAt: Date | null;
  readonly paidAt: Date | null;
  /**
   * 冪等キーの識別表示（指示書 §9.2）。
   *
   * ⚠️ **全体を持ち出さない。** 問い合わせの突き合わせに要るのは先頭の
   * 数文字で、全体を画面へ出しても運用の役に立たないまま、
   * 控えられる面だけが増える。切り詰めは実装側（DB 境界）で行う。
   */
  readonly idempotencyKeyPrefix: string;
  readonly createdAt: Date;
  readonly item: OrderItemView | null;
  readonly reservation: ReservationView | null;
  /** 決済行が付いているか。⚠️ 事業者側の識別子そのものは返さない。 */
  readonly hasPayment: boolean;
  /** 受取権が発行されているか。 */
  readonly entitlementCount: number;
}

export interface OrderItemView {
  readonly id: string;
  readonly listingId: string;
  readonly artworkId: string;
  readonly creatorAccountId: string;
  readonly titleSnapshot: string;
  readonly unitPriceAmount: number;
  readonly unitPriceCurrency: string;
  readonly quantity: number;
  readonly totalAmount: number;
}

export interface ReservationView {
  readonly id: string;
  readonly status: ReservationStatus;
  readonly quantity: number;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly releasedAt: Date | null;
}

/**
 * 冪等キーで引き当てた結果。
 *
 * ⚠️ **`conflict` を「同じ注文」に丸めない。** 同じキーで別の商品が
 * 来たときに前の注文を返すと、利用者は買ったつもりのない物を
 * 買わされる。指示書 §4.5 が 409 を求めているのはそのため。
 */
export type CreateOrderOutcome =
  | { readonly kind: 'created'; readonly order: OrderView }
  | { readonly kind: 'reused'; readonly order: OrderView }
  | { readonly kind: 'conflict' };

/** 期限切れの掃き出しで 1 件ぶん解放した結果。 */
export interface ReleasedReservation {
  readonly reservationId: string;
  readonly orderId: string;
  readonly artworkId: string;
  readonly quantity: number;
}

export interface OrderListQuery {
  readonly limit: number;
  readonly cursor?: string | undefined;
  readonly status?: OrderStatus | undefined;
  readonly accountId?: string | undefined;
}

export interface OrderListPage {
  readonly items: readonly OrderView[];
  readonly nextCursor: string | null;
}

export interface OrderRepository {
  /**
   * 注文・明細・仮引当を 1 トランザクションで作る。
   *
   * 実装の責務:
   * 1. 作品行を `FOR UPDATE` でロックする
   * 2. `accountId + idempotencyKey` で既存注文を探す
   *    （同じ商品なら `reused`、違う商品なら `conflict`）
   * 3. ロック後のカウンタで在庫を**再判定**する
   * 4. 注文・明細・仮引当を作り、作品の `reservedCount` を増やす
   *
   * ⚠️ 一意制約違反や CHECK 制約違反を握りつぶさない。
   * 握りつぶすと「作れなかったのに成功した」応答が返る。
   */
  createWithReservation(command: CreateOrderCommand): Promise<Result<CreateOrderOutcome, DomainError>>;

  findById(orderId: string): Promise<OrderView | null>;

  /** 一覧（運営用）。新しい順。 */
  list(query: OrderListQuery): Promise<OrderListPage>;

  /**
   * 期限切れの仮引当を解放し、注文を `expired` にする。
   *
   * ⚠️ **再実行で二重に解放しない。** 実装は
   * `WHERE status = 'reserved' AND expires_at <= now` の条件付き更新で
   * 1 件ずつ確保（claim）してから在庫を戻すこと。件数を数えてから
   * まとめて戻すと、同時に走った 2 本が同じ行を 2 回戻す。
   *
   * @param limit 1 回で扱う上限。バッチ実行できるようにするため。
   */
  releaseExpiredReservations(now: Date, limit: number): Promise<readonly ReleasedReservation[]>;
}
