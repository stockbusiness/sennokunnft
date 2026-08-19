import { domainError, type DomainError } from '../shared/errors';
import { err, ok, type Result } from '../shared/result';

/**
 * 在庫・販売枠の予約（指示書 §4.3・§4.4・§5.3）。
 *
 * ⚠️ **予約行は「跡」であって「正」ではない。** 売り越しを防いでいるのは
 * `artworks.reserved_count` と CHECK 制約のほう。この行は
 * 「いつ・どの注文が・いくつ押さえ、いつ解放したか」を追えるようにするもの。
 * ここを正にすると、行を作り忘れた瞬間に売り越す。
 */

export const RESERVATION_STATUSES = ['reserved', 'consumed', 'released'] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export function isReservationStatus(value: string): value is ReservationStatus {
  return (RESERVATION_STATUSES as readonly string[]).includes(value);
}

export interface Reservation {
  readonly id: string;
  readonly orderId: string;
  readonly listingId: string;
  readonly quantity: number;
  readonly status: ReservationStatus;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly releasedAt: Date | null;
}

/**
 * その予約を、いま解放してよいか。
 *
 * ⚠️ **期限だけで決めない。** すでに解放済み・消費済みの行を
 * もう一度解放すると、押さえていない在庫を戻すことになる。
 * つまり**在庫が増える**。再実行しても二重解放しないのは、
 * ここが `reserved` だけを通すから。
 */
export function canRelease(reservation: Reservation, now: Date): boolean {
  return reservation.status === 'reserved' && reservation.expiresAt.getTime() <= now.getTime();
}

/** 期限内かどうか。画面の表示に使う。 */
export function isExpired(reservation: Reservation, now: Date): boolean {
  return reservation.expiresAt.getTime() <= now.getTime();
}

export function releaseReservationRecord(
  reservation: Reservation,
  now: Date,
): Result<Reservation, DomainError> {
  if (reservation.status !== 'reserved') {
    return err(domainError('ORDER_TRANSITION_NOT_ALLOWED', 'reservation is not active'));
  }
  return ok({ ...reservation, status: 'released', releasedAt: now });
}

/**
 * 予約を消費する（決済確定時）。
 *
 * ⚠️ **Phase P2 で使う。** いまは呼ぶ経路が無いが、解放と対にして
 * 置いておく。片方だけあると、あとから足す人が対称性を崩す。
 */
export function consumeReservationRecord(
  reservation: Reservation,
  now: Date,
): Result<Reservation, DomainError> {
  if (reservation.status !== 'reserved') {
    return err(domainError('ORDER_TRANSITION_NOT_ALLOWED', 'reservation is not active'));
  }
  return ok({ ...reservation, status: 'consumed', consumedAt: now });
}

/**
 * 1 回の解放処理で扱う件数の上限（指示書 §4.4）。
 *
 * ⚠️ **上限を置く。** 溜まった期限切れを一度に全部処理すると、
 * その間ずっと在庫の行をロックし続け、購入が止まる。
 */
export const RELEASE_BATCH_SIZE = 100;
