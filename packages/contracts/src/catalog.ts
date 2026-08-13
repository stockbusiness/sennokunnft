import { z } from 'zod';

/**
 * カタログ API の契約。
 *
 * ここを単一の正とし、実行時検証と TypeScript 型の両方を導出する。
 * 手書きの型と検証を別々に持つと、必ず片方が古くなる。
 */

const moneyView = z.object({
  amount: z.number().int().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
});
export type MoneyView = z.infer<typeof moneyView>;

/** 公開カタログの一覧に出す作品。 */
export const artworkSummarySchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  imageKey: z.string().nullable(),
  /** 残り枚数。仮引当中の分は「売れていない」ではなく「買えない」として引く。 */
  availableSupply: z.number().int().nonnegative(),
  maxSupply: z.number().int().positive(),
  price: moneyView.nullable(),
  purchasable: z.boolean(),
});
export type ArtworkSummary = z.infer<typeof artworkSummarySchema>;

export const artworkDetailSchema = artworkSummarySchema.extend({
  description: z.string(),
  listingId: z.string().nullable(),
  maxQuantityPerOrder: z.number().int().positive().nullable(),
  /**
   * 購入できない場合の理由。
   *
   * ⚠️ 非公開作品はそもそも 404 にするので、ここに `artwork_not_published` は出ない。
   * 存在の有無を漏らさないため。
   */
  unavailableReason: z.enum(['listing_not_active', 'not_started', 'ended', 'sold_out']).nullable(),
});
export type ArtworkDetail = z.infer<typeof artworkDetailSchema>;

export const artworkListResponseSchema = z.object({
  items: z.array(artworkSummarySchema),
  nextCursor: z.string().nullable(),
});
export type ArtworkListResponse = z.infer<typeof artworkListResponseSchema>;

export const artworkListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(200).optional(),
});
export type ArtworkListQuery = z.infer<typeof artworkListQuerySchema>;

// ---------------------------------------------------------------------------
// 管理 API
// ---------------------------------------------------------------------------

export const ARTWORK_STATUS_VALUES = ['draft', 'published', 'archived'] as const;
export const LISTING_STATUS_VALUES = ['draft', 'active', 'paused', 'closed'] as const;

export const createArtworkRequestSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug は英小文字・数字・ハイフンのみ'),
  title: z.string().min(1).max(120),
  description: z.string().max(4000).optional(),
  imageKey: z.string().min(1).max(500).nullable().optional(),
  maxSupply: z.number().int().min(1).max(1_000_000),
});
export type CreateArtworkRequest = z.infer<typeof createArtworkRequestSchema>;

export const updateArtworkRequestSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  description: z.string().max(4000).optional(),
  imageKey: z.string().min(1).max(500).nullable().optional(),
  /** 公開後は変更できない（UD-205）。サーバー側で拒否する。 */
  maxSupply: z.number().int().min(1).max(1_000_000).optional(),
});
export type UpdateArtworkRequest = z.infer<typeof updateArtworkRequestSchema>;

export const adminArtworkSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  description: z.string(),
  imageKey: z.string().nullable(),
  maxSupply: z.number().int(),
  reservedCount: z.number().int(),
  issuedCount: z.number().int(),
  availableSupply: z.number().int(),
  status: z.enum(ARTWORK_STATUS_VALUES),
});
export type AdminArtwork = z.infer<typeof adminArtworkSchema>;

export const adminArtworkListResponseSchema = z.object({
  items: z.array(adminArtworkSchema),
  nextCursor: z.string().nullable(),
});
export type AdminArtworkListResponse = z.infer<typeof adminArtworkListResponseSchema>;

export const createListingRequestSchema = z.object({
  artworkId: z.uuid(),
  /** 最小通貨単位の整数。小数は受け付けない。 */
  priceAmount: z.number().int().nonnegative(),
  priceCurrency: z.string().regex(/^[A-Z]{3}$/),
  maxQuantityPerOrder: z.number().int().min(1).max(100).optional(),
  startsAt: z.iso.datetime().nullable().optional(),
  endsAt: z.iso.datetime().nullable().optional(),
});
export type CreateListingRequest = z.infer<typeof createListingRequestSchema>;

export const updateListingRequestSchema = z.object({
  priceAmount: z.number().int().nonnegative().optional(),
  priceCurrency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  maxQuantityPerOrder: z.number().int().min(1).max(100).optional(),
  startsAt: z.iso.datetime().nullable().optional(),
  endsAt: z.iso.datetime().nullable().optional(),
});
export type UpdateListingRequest = z.infer<typeof updateListingRequestSchema>;

export const adminListingSchema = z.object({
  id: z.string(),
  artworkId: z.string(),
  price: moneyView,
  maxQuantityPerOrder: z.number().int(),
  status: z.enum(LISTING_STATUS_VALUES),
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
});
export type AdminListing = z.infer<typeof adminListingSchema>;
