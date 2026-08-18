import { z } from 'zod';

/**
 * カタログ API の契約。
 *
 * ここを単一の正とし、実行時検証と TypeScript 型の両方を導出する。
 * 手書きの型と検証を別々に持つと、必ず片方が古くなる。
 */

export const ARTWORK_STATUS_VALUES = ['draft', 'published', 'archived'] as const;
export const LISTING_STATUS_VALUES = [
  'draft',
  'scheduled',
  'active',
  'suspended',
  'ended',
] as const;

/** 画面に出す表示上の状態。状態列と現在時刻から導く。 */
export const LISTING_DISPLAY_STATES = [
  'on_sale',
  'scheduled',
  'ended',
  'sold_out',
  'not_available',
] as const;

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
  /**
   * 表示用の画像URL。
   *
   * ⚠️ **`imageKey` から画面側で組み立てさせない。**
   * 組み立てるには公開ドメインが要り、それは保存先の設定
   * （`MEDIA_PUBLIC_BASE_URL`）にある。画面側にも同じ値を持たせると
   * **設定が 2 か所になってずれる**。ずれても落ちず、画像が出なくなるまで
   * 誰も気づけない。管理APIと同じく、サーバーが解決して渡す。
   */
  imageUrl: z.string().nullable(),
  /** 残り枚数。仮引当中の分は「売れていない」ではなく「買えない」として引く。 */
  availableSupply: z.number().int().nonnegative(),
  maxSupply: z.number().int().positive(),
  price: moneyView.nullable(),
  purchasable: z.boolean(),
  /** 表示上の状態。表示と購入で同じ判定を使うため、サーバーが決める。 */
  displayState: z.enum(LISTING_DISPLAY_STATES),
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

/** 公開向けの出品。作品と価格をまとめて返す。 */
export const publicListingSchema = z.object({
  id: z.string(),
  artworkId: z.string(),
  artworkSlug: z.string(),
  artworkTitle: z.string(),
  price: moneyView,
  maxQuantityPerOrder: z.number().int().positive(),
  displayState: z.enum(LISTING_DISPLAY_STATES),
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  availableSupply: z.number().int().nonnegative(),
  maxSupply: z.number().int().positive(),
});
export type PublicListing = z.infer<typeof publicListingSchema>;

export const publicListingListResponseSchema = z.object({
  items: z.array(publicListingSchema),
  nextCursor: z.string().nullable(),
});
export type PublicListingListResponse = z.infer<typeof publicListingListResponseSchema>;

// ---------------------------------------------------------------------------
// 管理 API
// ---------------------------------------------------------------------------

export const createArtworkRequestSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug は英小文字・数字・ハイフンのみ'),
  title: z.string().min(1).max(120),
  description: z.string().max(4000).optional(),
  maxSupply: z.number().int().min(1).max(1_000_000),
});
export type CreateArtworkRequest = z.infer<typeof createArtworkRequestSchema>;

export const updateArtworkRequestSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  description: z.string().max(4000).optional(),
  /** 公開後は変更できない（UD-205）。サーバー側で拒否する。 */
  maxSupply: z.number().int().min(1).max(1_000_000).optional(),
});
export type UpdateArtworkRequest = z.infer<typeof updateArtworkRequestSchema>;

export const adminArtworkSchema = z.object({
  id: z.string(),
  /** 登録した人（`UD-102` 決定変更 2026-08-18）。 */
  creatorAccountId: z.string(),
  slug: z.string(),
  title: z.string(),
  description: z.string(),
  imageKey: z.string().nullable(),
  imageUrl: z.string().nullable(),
  imageContentType: z.string().nullable(),
  imageByteSize: z.number().int().nullable(),
  maxSupply: z.number().int(),
  reservedCount: z.number().int(),
  issuedCount: z.number().int(),
  availableSupply: z.number().int(),
  status: z.enum(ARTWORK_STATUS_VALUES),
});
export type AdminArtwork = z.infer<typeof adminArtworkSchema>;

/**
 * 出品者が自分の作品を見るときの形。
 *
 * ⚠️ **運営向けと**同じ**にしてある。** 見せる相手は違うが、見せる中身は
 * どちらも「その作品の全部」で同じ。別々に定義すると、片方に列を足した
 * ときにもう片方が置いていかれる。
 *
 * 違うのは**どの作品を返すか**であって、1 件の形ではない。
 * 絞り込みは API 側（所有権チェック）の責務。
 */
export type CreatorArtwork = AdminArtwork;

export const adminArtworkListResponseSchema = z.object({
  items: z.array(adminArtworkSchema),
  nextCursor: z.string().nullable(),
});
export type AdminArtworkListResponse = z.infer<typeof adminArtworkListResponseSchema>;

export const createListingRequestSchema = z.object({
  artworkId: z.uuid(),
  /** 最小通貨単位の整数。小数は受け付けない。0 円の出品は作れない。 */
  priceAmount: z.number().int().positive(),
  priceCurrency: z.string().regex(/^[A-Z]{3}$/),
  maxQuantityPerOrder: z.number().int().min(1).max(100).optional(),
  startsAt: z.iso.datetime().nullable().optional(),
  endsAt: z.iso.datetime().nullable().optional(),
  displayOrder: z.number().int().min(0).max(10_000).optional(),
});
export type CreateListingRequest = z.infer<typeof createListingRequestSchema>;

export const updateListingRequestSchema = z.object({
  priceAmount: z.number().int().positive().optional(),
  priceCurrency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  maxQuantityPerOrder: z.number().int().min(1).max(100).optional(),
  startsAt: z.iso.datetime().nullable().optional(),
  endsAt: z.iso.datetime().nullable().optional(),
  displayOrder: z.number().int().min(0).max(10_000).optional(),
});
export type UpdateListingRequest = z.infer<typeof updateListingRequestSchema>;

export const adminListingSchema = z.object({
  id: z.string(),
  artworkId: z.string(),
  price: moneyView,
  maxQuantityPerOrder: z.number().int(),
  status: z.enum(LISTING_STATUS_VALUES),
  displayOrder: z.number().int(),
  displayState: z.enum(LISTING_DISPLAY_STATES),
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
});
export type AdminListing = z.infer<typeof adminListingSchema>;

/** 出品者が自分の出品を見るときの形（`CreatorArtwork` と同じ考え方）。 */
export type CreatorListing = AdminListing;

export const adminListingListResponseSchema = z.object({
  items: z.array(adminListingSchema),
  nextCursor: z.string().nullable(),
});
export type AdminListingListResponse = z.infer<typeof adminListingListResponseSchema>;

/** 画像アップロードの応答。保存キーと、実行時に解決した表示URLを返す。 */
export const uploadImageResponseSchema = z.object({
  imageKey: z.string(),
  imageUrl: z.string(),
  contentType: z.string(),
  byteSize: z.number().int().positive(),
});
export type UploadImageResponse = z.infer<typeof uploadImageResponseSchema>;
