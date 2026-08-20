import type { Artwork, Listing, OrderView, ReservationStatus } from '@sengoku/domain';
import { Prisma } from '../../generated/client';
import type { Artwork as ArtworkRow, Listing as ListingRow } from '../../generated/client';

/**
 * DB の行とドメインの型を相互に変換する。
 *
 * この変換を挟むのは、Prisma の生成型をドメインへ持ち込まないため。
 * 直接渡すと、列名の変更や ORM の乗り換えがドメインまで波及する。
 */

/**
 * 作品の行をドメインの型へ移す。
 *
 * ⚠️ **表示名は行に無い（別テーブル）。** 引いてきた場合だけ渡す。
 * ここで既定の文言（「（未登録）」など）を作らない——文言は画面が決める。
 */
export function toArtwork(row: ArtworkRow, creatorDisplayName: string | null = null): Artwork {
  return {
    id: row.id,
    creatorAccountId: row.creatorAccountId,
    creatorDisplayName,
    slug: row.slug,
    title: row.title,
    description: row.description,
    imageKey: row.imageKey,
    imageContentType: row.imageContentType,
    imageByteSize: row.imageByteSize,
    imageHash: row.imageHash,
    maxSupply: row.maxSupply,
    reservedCount: row.reservedCount,
    issuedCount: row.issuedCount,
    status: row.status,
  };
}

export function toListing(row: ListingRow): Listing {
  return {
    id: row.id,
    artworkId: row.artworkId,
    price: { amountMinor: row.priceAmount, currency: row.priceCurrency.trim() },
    maxQuantityPerOrder: row.maxQuantityPerOrder,
    status: row.status,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    displayOrder: row.displayOrder,
  };
}

/**
 * キーセットページング用のカーソル。
 *
 * オフセットではなくキーセットにしているのは、
 * ページを辿っている間に件数が増減しても取りこぼしや重複が起きないため。
 * UUID v4 は時系列に並ばないので、`createdAt` を主キーに `id` を同着解消に使う。
 */
export interface Cursor {
  readonly createdAt: Date;
  readonly id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.createdAt.toISOString()}|${cursor.id}`, 'utf8').toString(
    'base64url',
  );
}

/**
 * カーソルを復元する。
 *
 * 不正な値は例外にせず `null` を返す。カーソルは利用者が自由に書き換えられる
 * 入力なので、壊れていたら「先頭から」に落とすほうが安全で、
 * 500 を返して攻撃者に内部エラーを観測させるより望ましい。
 */
export function decodeCursor(raw: string | undefined): Cursor | null {
  if (raw === undefined || raw === '') {
    return null;
  }
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const separator = decoded.lastIndexOf('|');
    if (separator === -1) {
      return null;
    }
    const createdAt = new Date(decoded.slice(0, separator));
    const id = decoded.slice(separator + 1);
    if (Number.isNaN(createdAt.getTime()) || id.length === 0) {
      return null;
    }
    return { createdAt, id };
  } catch {
    return null;
  }
}

/**
 * 注文を画面向けの形へ読み出すときの `include`。
 *
 * ⚠️ **`select` を絞ってある関連だけを引く。** 何も指定せずに関連ごと引くと、
 * 決済事業者側の識別子まで応答へ載る道ができる。ここでは
 * 「決済行が有るか」「受取権が何件か」だけが要る。
 */
/** 冪等キーの識別表示に使う長さ。⚠️ 全体を層の外へ出さない。 */
const IDEMPOTENCY_KEY_PREFIX_LENGTH = 8;

export const ORDER_VIEW_INCLUDE = {
  lines: true,
  reservations: { orderBy: [{ createdAt: 'desc' }] },
  payments: { select: { id: true } },
  entitlements: { select: { id: true } },
} satisfies Prisma.OrderInclude;

type OrderRowWithRelations = Prisma.OrderGetPayload<{ include: typeof ORDER_VIEW_INCLUDE }>;

export function toOrderView(row: OrderRowWithRelations): OrderView {
  const line = row.lines[0];
  // 予約は新しい順。有効なものがあればそれを、無ければ最後の 1 件を見せる。
  // ⚠️ 「無い」と「解放済み」を同じ表示にしない。運用が判断できなくなる。
  const reservation =
    row.reservations.find((entry) => entry.status === 'reserved') ?? row.reservations[0];
  return {
    id: row.id,
    orderNumber: row.orderNumber,
    accountId: row.accountId,
    creatorAccountId: row.creatorAccountId,
    status: row.status as OrderView['status'],
    paymentStatus: row.paymentStatus as OrderView['paymentStatus'],
    fulfillmentStatus: row.fulfillmentStatus as OrderView['fulfillmentStatus'],
    refundStatus: row.refundStatus as OrderView['refundStatus'],
    currency: row.totalCurrency.trim(),
    subtotalAmount: row.subtotalAmount,
    discountAmount: row.discountAmount,
    totalAmount: row.totalAmount,
    platformFeeRateBps: row.platformFeeRateBps,
    platformFeeAmount: row.platformFeeAmount,
    creatorAmount: row.creatorAmount,
    reservationExpiresAt: row.reservedUntil,
    paidAt: row.paidAt,
    // ⚠️ ここで切り詰める。全体を層の外へ出さない。
    idempotencyKeyPrefix: row.idempotencyKey.slice(0, IDEMPOTENCY_KEY_PREFIX_LENGTH),
    createdAt: row.createdAt,
    item:
      line === undefined
        ? null
        : {
            id: line.id,
            listingId: line.listingId,
            artworkId: line.artworkId,
            creatorAccountId: line.creatorAccountId,
            titleSnapshot: line.artworkTitleSnapshot,
            // ⚠️ 注文時点の表示名。この列より前の注文では `null`。
            creatorNameSnapshot: line.creatorNameSnapshot,
            unitPriceAmount: line.unitPriceAmount,
            unitPriceCurrency: line.unitPriceCurrency.trim(),
            quantity: line.quantity,
            totalAmount: line.totalAmount,
          },
    reservation:
      reservation === undefined
        ? null
        : {
            id: reservation.id,
            status: reservation.status as ReservationStatus,
            quantity: reservation.quantity,
            expiresAt: reservation.expiresAt,
            consumedAt: reservation.consumedAt,
            releasedAt: reservation.releasedAt,
          },
    hasPayment: row.payments.length > 0,
    entitlementCount: row.entitlements.length,
  };
}
