import type { Artwork } from '../catalog/artwork';
import { evaluatePurchasability, unavailableReasonToError, type Listing } from '../catalog/listing';
import { domainError, type DomainError } from '../shared/errors';
import { err, ok, type Result } from '../shared/result';
import { reserveSupply, type SupplyCounters } from '../supply/supply';
import { multiplyMoney, type Money } from '../value-objects/money';
import { validateQuantity } from '../value-objects/quantity';

/**
 * 注文の作成（`MVP_SCOPE.md` / 方針変更 2026-08-14 §8）。
 *
 * ⚠️ **この関数だけではオーバーセルを防げない。**
 * 読み取りと書き込みのあいだに別の注文が割り込む。
 * 実際の排他は「作品行を `FOR UPDATE` でロックしたうえで本関数を使い、
 * DB の CHECK 制約（reserved + issued <= max）を最終防壁にする」で成立する。
 * ここは、明らかに通せない要求を手前で弾き、**保存すべき値を決める**役。
 *
 * ⚠️ **決済事業者を前提にしない。** ここに事業者の概念を持ち込むと、
 * 乗り換えるときにドメインごと書き直しになる（同 §9）。
 * 注文は「代金が確定した意思表示」までを表し、決済の成否は別の層が扱う。
 */

/** 仮引当の既定の持ち時間。 */
export const DEFAULT_RESERVATION_MINUTES = 30;

export interface OrderLineDraft {
  readonly listingId: string;
  readonly artworkId: string;
  /** ⚠️ 注文時点の作品名。**マスタを参照して表示しない。** */
  readonly artworkTitleSnapshot: string;
  /** ⚠️ 注文時点の単価。あとで値段が変わっても、この注文には影響させない。 */
  readonly unitPrice: Money;
  readonly quantity: number;
}

export interface OrderDraft {
  readonly accountId: string;
  readonly lines: readonly OrderLineDraft[];
  readonly total: Money;
  /** この時刻を過ぎたら仮引当を解放する。 */
  readonly reservedUntil: Date;
  /** 引当後の在庫カウンタ。呼び出し元が同一トランザクションで書く。 */
  readonly reservedCounters: SupplyCounters;
}

export interface CreateOrderInput {
  readonly accountId: string;
  readonly listing: Listing;
  readonly artwork: Artwork;
  readonly counters: SupplyCounters;
  readonly quantity: number;
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
  const total = multiplyMoney(listing.price, quantity);
  if (!total.ok) {
    return total;
  }

  const minutes = input.reservationMinutes ?? DEFAULT_RESERVATION_MINUTES;
  return ok({
    accountId,
    lines: [
      {
        listingId: listing.id,
        artworkId: artwork.id,
        // スナップショット。あとで作品名や価格が変わっても注文は動かない。
        artworkTitleSnapshot: artwork.title,
        unitPrice: listing.price,
        quantity,
      },
    ],
    total: total.value,
    reservedUntil: new Date(now.getTime() + minutes * 60_000),
    reservedCounters: reserved.value,
  });
}
