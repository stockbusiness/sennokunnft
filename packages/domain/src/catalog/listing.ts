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
  /** 一覧での並び順。小さいほど前に出る。 */
  readonly displayOrder: number;
}

export interface CreateListingInput {
  readonly id: string;
  readonly artworkId: string;
  readonly priceAmount: number;
  readonly priceCurrency: string;
  readonly maxQuantityPerOrder?: number;
  readonly startsAt?: Date | null;
  readonly endsAt?: Date | null;
  readonly displayOrder?: number;
}

function validatePeriod(startsAt: Date | null, endsAt: Date | null): DomainError | null {
  if (startsAt !== null && endsAt !== null && startsAt.getTime() >= endsAt.getTime()) {
    return domainError('LISTING_PERIOD_INVALID', 'startsAt must be earlier than endsAt');
  }
  return null;
}

/**
 * 価格を検証する。
 *
 * ⚠️ **0 円の出品は作れない。**
 * 無償配布は「販売」とは別の導線（配布・特典）として扱うべきで、
 * 価格 0 の注文を決済フローに流すと、決済事業者側の最小金額や
 * 返金の扱いで例外だらけになる。
 * 無償配布が必要になったら、専用の仕組みとして設計する。
 */
function validatePrice(amount: number, currency: string): Result<Money, DomainError> {
  const money = createMoney(amount, currency);
  if (!money.ok) {
    return money;
  }
  if (money.value.amountMinor <= 0) {
    return err(domainError('INVALID_MONEY', 'price must be greater than zero'));
  }
  return money;
}

function validateQuantityLimit(value: number): DomainError | null {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_QUANTITY_PER_ORDER) {
    return domainError('INVALID_QUANTITY', 'maxQuantityPerOrder is out of range');
  }
  return null;
}

/** 出品を下書きとして作る。販売開始は別操作。 */
export function createListing(input: CreateListingInput): Result<Listing, DomainError> {
  const price = validatePrice(input.priceAmount, input.priceCurrency);
  if (!price.ok) {
    return price;
  }

  const maxQuantity = input.maxQuantityPerOrder ?? 1;
  const quantityError = validateQuantityLimit(maxQuantity);
  if (quantityError !== null) {
    return err(quantityError);
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
    displayOrder: input.displayOrder ?? 0,
  });
}

export interface UpdateListingInput {
  readonly priceAmount?: number;
  readonly priceCurrency?: string;
  readonly maxQuantityPerOrder?: number;
  readonly startsAt?: Date | null;
  readonly endsAt?: Date | null;
  readonly displayOrder?: number;
}

/**
 * 出品を更新する。
 *
 * ⚠️ **販売中（`active`）と終了後（`ended`）は編集できない。**
 *
 * 注文は作成時点の価格をスナップショットするので、
 * 技術的には販売中に価格を変えても過去の注文は壊れない。
 * それでも禁じるのは、購入者が価格を見てから決済を終えるまでの間に
 * 表示が変わる状況を作らないため。
 * 変更したいときは一度 `suspended` にしてから編集する。
 */
export function updateListing(
  listing: Listing,
  input: UpdateListingInput,
): Result<Listing, DomainError> {
  if (listing.status === 'active' || listing.status === 'ended') {
    return err(
      domainError('LISTING_NOT_EDITABLE', `listing in status ${listing.status} cannot be edited`),
    );
  }

  let price = listing.price;
  if (input.priceAmount !== undefined || input.priceCurrency !== undefined) {
    const next = validatePrice(
      input.priceAmount ?? listing.price.amountMinor,
      input.priceCurrency ?? listing.price.currency,
    );
    if (!next.ok) {
      return next;
    }
    price = next.value;
  }

  const maxQuantity = input.maxQuantityPerOrder ?? listing.maxQuantityPerOrder;
  const quantityError = validateQuantityLimit(maxQuantity);
  if (quantityError !== null) {
    return err(quantityError);
  }

  const startsAt = input.startsAt === undefined ? listing.startsAt : input.startsAt;
  const endsAt = input.endsAt === undefined ? listing.endsAt : input.endsAt;
  const periodError = validatePeriod(startsAt, endsAt);
  if (periodError !== null) {
    return err(periodError);
  }

  return ok({
    ...listing,
    price,
    maxQuantityPerOrder: maxQuantity,
    startsAt,
    endsAt,
    displayOrder: input.displayOrder ?? listing.displayOrder,
  });
}

/**
 * 販売を開始する。
 *
 * 作品が公開されていない状態で出品を有効にできてしまうと、
 * カタログに出ていないものが購入できる経路ができる。
 *
 * 開始日時が未来なら `scheduled`、それ以外は `active` にする。
 * 「開始時刻になったら状態列を書き換えるバッチ」を前提にしないのは、
 * バッチが遅れただけで売れなくなるため。実際の購入可否は
 * `evaluatePurchasability` が現在時刻を見て判定する。
 */
export function activateListing(
  listing: Listing,
  artwork: Artwork,
  now: Date,
): Result<Listing, DomainError> {
  if (!isPubliclyVisible(artwork)) {
    return err(domainError('ARTWORK_NOT_PUBLISHED', 'artwork must be published first'));
  }
  if (listing.endsAt !== null && listing.endsAt.getTime() <= now.getTime()) {
    return err(domainError('LISTING_PERIOD_INVALID', 'listing period has already ended'));
  }

  const target: ListingStatus =
    listing.startsAt !== null && listing.startsAt.getTime() > now.getTime()
      ? 'scheduled'
      : 'active';

  const transition = listingStateMachine.transition(listing.status, target);
  if (!transition.ok) {
    return transition;
  }
  return ok({ ...listing, status: transition.value });
}

/** 一時停止する。編集してから再開できる。 */
export function suspendListing(listing: Listing): Result<Listing, DomainError> {
  const transition = listingStateMachine.transition(listing.status, 'suspended');
  if (!transition.ok) {
    return transition;
  }
  return ok({ ...listing, status: transition.value });
}

/** 販売を終了する。終端なので元に戻せない。 */
export function endListing(listing: Listing): Result<Listing, DomainError> {
  const transition = listingStateMachine.transition(listing.status, 'ended');
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
  // scheduled は「販売予定」であって販売中ではない。
  if (listing.status !== 'active' && listing.status !== 'scheduled') {
    return err('listing_not_active');
  }
  if (listing.startsAt !== null && now.getTime() < listing.startsAt.getTime()) {
    return err('not_started');
  }
  if (listing.endsAt !== null && now.getTime() >= listing.endsAt.getTime()) {
    return err('ended');
  }
  // ここへ到達した `scheduled` は、開始日時を過ぎている＝実質販売中。
  // 状態列を書き換えるバッチを待たずに購入できる。これが `scheduled` を
  // 「予約」として扱う設計の要点で、バッチ遅延で売れなくなる事故を防ぐ。
  //
  // 「開始日時が無いのに scheduled」という不整合は、DB の CHECK 制約
  // (listings_scheduled_requires_start) が作らせないようにしている。
  if (!hasRemainingSupply(artwork)) {
    return err('sold_out');
  }
  return ok(listing);
}

/** 画面に出す表示上の状態。状態列と現在時刻から導く。 */
export type ListingDisplayState = 'on_sale' | 'scheduled' | 'ended' | 'sold_out' | 'not_available';

/**
 * 表示状態を決める。
 *
 * ⚠️ **現在時刻は引数で受け取る。** `new Date()` を直接呼ばないのは、
 * テストで時刻を固定できるようにするため（`ClockPort` 経由で渡す）。
 */
export function resolveDisplayState(input: PurchasabilityInput): ListingDisplayState {
  // 「販売を終了した」ことは、期間切れかどうかに関わらず伝える。
  // ここを購入可否の判定だけに任せると、終了した出品が
  // 「ただいま販売しておりません」になり、再開を待たせてしまう。
  if (input.listing.status === 'ended') {
    return 'ended';
  }

  const result = evaluatePurchasability(input);
  if (result.ok) {
    return 'on_sale';
  }
  switch (result.error) {
    case 'not_started':
      return 'scheduled';
    case 'ended':
      return 'ended';
    case 'sold_out':
      return 'sold_out';
    case 'artwork_not_published':
    case 'listing_not_active':
      return 'not_available';
  }
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
