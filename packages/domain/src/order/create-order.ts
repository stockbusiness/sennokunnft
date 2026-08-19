import type { Artwork } from '../catalog/artwork';
import { evaluatePurchasability, unavailableReasonToError, type Listing } from '../catalog/listing';
import { domainError, type DomainError } from '../shared/errors';
import { err, ok, type Result } from '../shared/result';
import { reserveSupply, type SupplyCounters } from '../supply/supply';
import { multiplyMoney, type Money } from '../value-objects/money';
import { validateQuantity } from '../value-objects/quantity';
import { calculateOrderAmounts, type OrderAmounts } from './pricing';
import type {
  FulfillmentStatus,
  OrderPaymentStatus,
  OrderStatus,
  RefundStatus,
} from './order-status';

/**
 * 注文の組み立て（決済 Phase P1・指示書 §4.2）。
 *
 * ⚠️ **この関数だけではオーバーセルを防げない。**
 * 読み取りと書き込みのあいだに別の注文が割り込む。
 * 実際の排他は「作品行を `FOR UPDATE` でロックしたうえで本関数を使い、
 * DB の CHECK 制約（reserved + issued <= max）を最終防壁にする」で成立する。
 * ここは、明らかに通せない要求を手前で弾き、**保存すべき値を決める**役。
 *
 * ⚠️ **ブラウザから金額を受け取らない。** 単価も手数料率もここでは
 * 引数として与えられるが、**その出どころは DB と設定**であることを
 * 呼び出し側の責務とする（指示書 §4.2）。
 *
 * ⚠️ **決済事業者を知らない。** 注文は「代金が確定した意思表示」までを表す。
 * Stripe の概念をここへ持ち込むと、乗り換えるときにドメインごと書き直しになる。
 */

/** 仮引当の既定の持ち時間（指示書 §4.3）。 */
export const DEFAULT_RESERVATION_MINUTES = 30;

export interface OrderItemDraft {
  readonly listingId: string;
  readonly artworkId: string;
  /** ⚠️ 出品者。注文時点のものを持つ。作品の持ち主が変わっても動かさない。 */
  readonly creatorAccountId: string;
  /** ⚠️ 注文時点の作品名。**マスタを参照して表示しない。** */
  readonly titleSnapshot: string;
  /** ⚠️ 注文時点の単価。あとで値段が変わっても、この注文には影響させない。 */
  readonly unitPrice: Money;
  readonly quantity: number;
  readonly totalAmount: number;
}

export interface OrderDraft {
  readonly accountId: string;
  /** 共通顧客ID。まだ解決できていなければ `null`。 */
  readonly commonUserId: string | null;
  /** ⚠️ 1 注文 1 クリエイター（指示書 §3-4）。明細から取る。 */
  readonly creatorAccountId: string;
  readonly currency: string;
  readonly amounts: OrderAmounts;
  readonly items: readonly OrderItemDraft[];
  readonly orderStatus: OrderStatus;
  readonly paymentStatus: OrderPaymentStatus;
  readonly fulfillmentStatus: FulfillmentStatus;
  readonly refundStatus: RefundStatus;
  /** この時刻を過ぎたら仮引当を解放する。 */
  readonly reservationExpiresAt: Date;
  /** 引当後の在庫カウンタ。呼び出し元が同一トランザクションで書く。 */
  readonly reservedCounters: SupplyCounters;
}

export interface CreateOrderInput {
  readonly accountId: string;
  readonly commonUserId: string | null;
  readonly listing: Listing;
  readonly artwork: Artwork;
  /** ⚠️ 出品者。`artwork` から取らず、呼び出し側が明示的に渡す。 */
  readonly creatorAccountId: string;
  readonly counters: SupplyCounters;
  readonly quantity: number;
  /** 注文時点の手数料率（bps）。⚠️ 設定から解決した値を渡す。 */
  readonly platformFeeRateBps: number;
  readonly now: Date;
  readonly reservationMinutes?: number;
}

/**
 * 注文を組み立てる。
 *
 * ⚠️ **判定の順序に意味がある。**
 * 「買える出品か」を先に見る。数量や在庫より先に見ないと、
 * 販売していない作品について在庫の有無を答えることになり、
 * **未公開の作品の存在と残数を外から探れてしまう。**
 */
export function createOrder(input: CreateOrderInput): Result<OrderDraft, DomainError> {
  const { accountId, listing, artwork, counters, quantity, now } = input;

  // 1. そもそも買える出品か。未公開・販売前・終了済みをここで弾く。
  const purchasable = evaluatePurchasability({ listing, artwork, now });
  if (!purchasable.ok) {
    return err(unavailableReasonToError(purchasable.error));
  }

  // 2. 出品と作品の対応。取り違えた組み合わせで注文させない。
  //    ⚠️ 呼び出し元が別々に読み込むため、ここで必ず突き合わせる。
  //    突き合わせないと、安い出品のIDと高い作品のIDを組み合わせられる。
  if (listing.artworkId !== artwork.id) {
    return err(domainError('ARTWORK_NOT_AVAILABLE', 'listing does not belong to the artwork'));
  }

  // 3. 数量。全体の上限と、この出品の上限の両方を見る。
  const validQuantity = validateQuantity(quantity);
  if (!validQuantity.ok) {
    return validQuantity;
  }
  if (quantity > listing.maxQuantityPerOrder) {
    return err(
      domainError('INVALID_QUANTITY', 'quantity exceeds the maximum allowed for this listing'),
    );
  }

  // 4. 在庫の仮引当。ここで足りなければ注文を作らない。
  const reserved = reserveSupply(counters, quantity);
  if (!reserved.ok) {
    return reserved;
  }

  // 5. 金額。⚠️ 単価 × 数量を整数で計算する。浮動小数点を使わない。
  const subtotal = multiplyMoney(listing.price, quantity);
  if (!subtotal.ok) {
    return subtotal;
  }
  const amounts = calculateOrderAmounts({
    subtotalAmount: subtotal.value.amountMinor,
    // ⚠️ 今回の値引は常に 0。列と計算だけ先に用意する（指示書 §6）。
    discountAmount: 0,
    platformFeeRateBps: input.platformFeeRateBps,
  });
  if (!amounts.ok) {
    return amounts;
  }

  const minutes = input.reservationMinutes ?? DEFAULT_RESERVATION_MINUTES;
  return ok({
    accountId,
    commonUserId: input.commonUserId,
    creatorAccountId: input.creatorAccountId,
    currency: listing.price.currency,
    amounts: amounts.value,
    items: [
      {
        listingId: listing.id,
        artworkId: artwork.id,
        creatorAccountId: input.creatorAccountId,
        // スナップショット。あとで作品名や価格が変わっても注文は動かない。
        titleSnapshot: artwork.title,
        unitPrice: listing.price,
        quantity,
        totalAmount: subtotal.value.amountMinor,
      },
    ],
    // ⚠️ 作った直後は、決済も付与も返金も「まだ何も起きていない」。
    //    ここを `pending` などで埋めると、始まっていないものが
    //    進行中に見える。
    orderStatus: 'pending',
    paymentStatus: 'not_started',
    fulfillmentStatus: 'not_started',
    refundStatus: 'none',
    reservationExpiresAt: new Date(now.getTime() + minutes * 60_000),
    reservedCounters: reserved.value,
  });
}
