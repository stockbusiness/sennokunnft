import type { Artwork, Listing } from '@sengoku/domain';
import type { Artwork as ArtworkRow, Listing as ListingRow } from '../../generated/client';

/**
 * DB の行とドメインの型を相互に変換する。
 *
 * この変換を挟むのは、Prisma の生成型をドメインへ持ち込まないため。
 * 直接渡すと、列名の変更や ORM の乗り換えがドメインまで波及する。
 */

export function toArtwork(row: ArtworkRow): Artwork {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    imageKey: row.imageKey,
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
