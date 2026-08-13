import { domainError, type DomainError } from '../shared/errors';
import { err, ok, type Result } from '../shared/result';
import { listingStateMachine, type ListingStatus } from '../state/machines';
import { createMoney, type Money } from '../value-objects/money';
import { MAX_QUANTITY_PER_ORDER } from '../value-objects/quantity';
import { hasRemainingSupply, isPubliclyVisible, type Artwork } from './artwork';

/** 出品。1 作品に対して複数作れる（価格改定や再販を履歴として残せるようにするため）。 */
export interface Listing {
  readonly id: string;
  readonly artworkId: string;
  readonly price: Money;
  readonly maxQuantityPerOrder: number;
  readonly status: ListingStatus;
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
}

export interface CreateListingInput {
  readonly id: string;
  readonly artworkId: string;
  readonly priceAmount: number;
  readonly priceCurrency: string;
  readonly maxQuantityPerOrder?: number;
  readonly startsAt?: Date | null;
  readonly endsAt?: Date | null;
}

function validatePeriod(startsAt: Date | null, endsAt: Date | null): DomainError | null {
  if (startsAt !== null && endsAt !== null && startsAt.getTime() >= endsAt.getTime()) {
    return domainError('LISTING_PERIOD_INVALID', 'startsAt must be earlier than endsAt');
  }
  return null;
}

/** 出品を下書きとして作る。販売開始は別操作。 */
export function createListing(input: CreateListingInput): Result<Listing, DomainError> {
  const price = createMoney(input.priceAmount, input.priceCurrency);
  if (!price.ok) {
    return price;
  }

  const maxQuantity = input.maxQuantityPerOrder ?? 1;
  if (
    !Number.isSafeInteger(maxQuantity) ||
    maxQuantity < 1 ||
    maxQuantity > MAX_QUANTITY_PER_ORDER
  ) {
    return err(domainError('INVALID_QUANTITY', 'maxQuantityPerOrder is out of range'));
  }

  const startsAt = input.startsAt ?? null;
  const endsAt = input.endsAt ?? null;
  const periodError = validatePeriod(startsAt, endsAt);
  if (periodError !== null) {
    return err(periodError);
  }

  return ok({
    id: input.id,
    artworkId: input.artworkId,
    price: price.value,
    maxQuantityPerOrder: maxQuantity,
    status: 'draft',
    startsAt,
    endsAt,
  });
}

export interface UpdateListingInput {
  readonly priceAmount?: number;
  readonly priceCurrency?: string;
  readonly maxQuantityPerOrder?: number;
  readonly startsAt?: Date | null;
  readonly endsAt?: Date | null;
}

/**
 * 出品を更新する。
 *
 * ⚠️ **販売中（`active`）の出品は編集できない。**
 *
 * 注文は作成時点の価格をスナップショットするので、
 * 技術的には販売中に価格を変えても過去の注文は壊れない。
 * それでも禁じるのは、購入者が価格を見てから決済を終えるまでの間に
 * 表示が変わる状況を作らないため。
 * 変更したいときは一度 `paused` にしてから編集する。
 */
export function updateListing(
  listing: Listing,
  input: UpdateListingInput,
): Result<Listing, DomainError> {
  if (listing.status === 'active' || listing.status === 'closed') {
    return err(
      domainError('LISTING_NOT_EDITABLE', `listing in status ${listing.status} cannot be edited`),
    );
  }

  let price = listing.price;
  if (input.priceAmount !== undefined || input.priceCurrency !== undefined) {
    const next = createMoney(
      input.priceAmount ?? listing.price.amountMinor,
      input.priceCurrency ?? listing.price.currency,
    );
    if (!next.ok) {
      return next;
    }
    price = next.value;
  }

  const maxQuantity = input.maxQuantityPerOrder ?? listing.maxQuantityPerOrder;
  if (
    !Number.isSafeInteger(maxQuantity) ||
    maxQuantity < 1 ||
    maxQuantity > MAX_QUANTITY_PER_ORDER
  ) {
    return err(domainError('INVALID_QUANTITY', 'maxQuantityPerOrder is out of range'));
  }

  const startsAt = input.startsAt === undefined ? listing.startsAt : input.startsAt;
  const endsAt = input.endsAt === undefined ? listing.endsAt : input.endsAt;
  const periodError = validatePeriod(startsAt, endsAt);
  if (periodError !== null) {
    return err(periodError);
  }

  return ok({ ...listing, price, maxQuantityPerOrder: maxQuantity, startsAt, endsAt });
}

/**
 * 販売を開始する。
 *
 * 作品が公開されていない状態で出品を有効にできてしまうと、
 * カタログに出ていないものが購入できる経路ができる。
 */
export function activateListing(listing: Listing, artwork: Artwork): Result<Listing, DomainError> {
  if (!isPubliclyVisible(artwork)) {
    return err(domainError('ARTWORK_NOT_PUBLISHED', 'artwork must be published first'));
  }
  const transition = listingStateMachine.transition(listing.status, 'active');
  if (!transition.ok) {
    return transition;
  }
  return ok({ ...listing, status: transition.value });
}

export function pauseListing(listing: Listing): Result<Listing, DomainError> {
  const transition = listingStateMachine.transition(listing.status, 'paused');
  if (!transition.ok) {
    return transition;
  }
  return ok({ ...listing, status: transition.value });
}

export function closeListing(listing: Listing): Result<Listing, DomainError> {
  const transition = listingStateMachine.transition(listing.status, 'closed');
  if (!transition.ok) {
    return transition;
  }
  return ok({ ...listing, status: transition.value });
}

/** 購入可否の判定に失敗したときの理由。 */
export type UnavailableReason =
  'artwork_not_published' | 'listing_not_active' | 'not_started' | 'ended' | 'sold_out';

export interface PurchasabilityInput {
  readonly listing: Listing;
  readonly artwork: Artwork;
  readonly now: Date;
}

/**
 * いま購入できるかを判定する。
 *
 * **表示と購入で同じ関数を使う。** 画面が「購入できます」と出しているのに
 * サーバーが弾く（あるいはその逆）という食い違いを、判定を 1 箇所にすることで防ぐ。
 * 実際の在庫確保は行ロック付きで別途行う（この判定だけでは同時購入を防げない）。
 */
export function evaluatePurchasability(
  input: PurchasabilityInput,
): Result<Listing, UnavailableReason> {
  const { listing, artwork, now } = input;

  if (!isPubliclyVisible(artwork)) {
    return err('artwork_not_published');
  }
  if (listing.status !== 'active') {
    return err('listing_not_active');
  }
  if (listing.startsAt !== null && now.getTime() < listing.startsAt.getTime()) {
    return err('not_started');
  }
  if (listing.endsAt !== null && now.getTime() >= listing.endsAt.getTime()) {
    return err('ended');
  }
  if (!hasRemainingSupply(artwork)) {
    return err('sold_out');
  }
  return ok(listing);
}

/** 判定結果をドメインエラーに移す（api 層が HTTP へ写せるように）。 */
export function unavailableReasonToError(reason: UnavailableReason): DomainError {
  switch (reason) {
    case 'artwork_not_published':
      // 非公開作品の存在を漏らさないため、状態ではなく「見つからない」として扱う。
      return domainError('ARTWORK_NOT_AVAILABLE', 'artwork is not published');
    case 'sold_out':
      return domainError('INSUFFICIENT_SUPPLY', 'sold out');
    case 'listing_not_active':
    case 'not_started':
    case 'ended':
      return domainError('LISTING_NOT_ACTIVE', reason);
  }
}
