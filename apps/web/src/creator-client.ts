import {
  adminArtworkSchema,
  adminListingSchema,
  uploadImageResponseSchema,
  type CreatorArtwork,
  type CreatorListing,
} from '@sengoku/contracts';
import { z } from '@sengoku/validation';
import { getWebEnv } from './env';
import { currentAccessToken } from './auth/current';

/**
 * 出品者向け API（`/api/v1/creator/**`）の呼び出し。
 *
 * ⚠️ **サーバー側でのみ使う。** 資格情報をブラウザへ渡さないため。
 *
 * ⚠️ **画面を隠すことは保護ではない。** 画面を出さなくても API は直接叩ける。
 * 「その作品はあなたのものか」の判定は必ず API 側が行う。ここは入口を用意するだけ。
 */

/**
 * いま操作している人の資格情報。
 *
 * ⚠️ **ログイン済みなら、必ずその人のトークンを使う。**
 * 運営の資格情報（`ADMIN_DEV_TOKEN`）は 1 本しか無く、使うと全員が
 * 同じ人として扱われる。ログインしているのにそちらへ落ちると、
 * **自分の出品欄のつもりで他人の作品を触れてしまう。**
 *
 * ⚠️ **落ちる先を残しているのは、ログイン機能を有効にしていない環境のため。**
 * Supabase の設定が入っていない手元では、従来どおり動かしたい。
 * 設定が入った環境では `currentAccessToken()` が返るので、こちらは使われない。
 */
async function creatorToken(): Promise<string | null> {
  const session = await currentAccessToken();
  if (session !== null) {
    return session;
  }
  const env = getWebEnv();
  if (env.SUPABASE_URL !== undefined && env.SUPABASE_ANON_KEY !== undefined) {
    // ログイン機能が有効な環境では、未ログインを運営の資格情報で埋めない。
    return null;
  }
  const token = env.ADMIN_DEV_TOKEN;
  return token === undefined || token === '' ? null : token;
}

export type CreatorResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly reason: 'unauthorized' | 'not_found' | 'rejected' | 'unavailable';
    };

/** 出品者向け一覧の形。件数が増えたときの続きは `nextCursor` で辿る。 */
const creatorArtworkListSchema = z.object({
  items: z.array(adminArtworkSchema),
  nextCursor: z.string().nullable(),
});
const creatorListingListSchema = z.object({
  items: z.array(adminListingSchema),
  nextCursor: z.string().nullable(),
});

async function call<T>(
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit = {},
): Promise<CreatorResult<T>> {
  const token = await creatorToken();
  if (token === null) {
    return { ok: false, reason: 'unauthorized' };
  }

  const { WEB_API_BASE_URL } = getWebEnv();
  let response: Response;
  try {
    response = await fetch(`${WEB_API_BASE_URL}${path}`, {
      ...init,
      headers: {
        ...init.headers,
        authorization: `Bearer ${token}`,
        accept: 'application/json',
      },
      cache: 'no-store',
    });
  } catch {
    return { ok: false, reason: 'unavailable' };
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: 'unauthorized' };
  }
  if (response.status === 404) {
    return { ok: false, reason: 'not_found' };
  }
  // 入力の誤りと、こちら側の不調を分ける。利用者に見せる言葉が違うため。
  if (response.status >= 400 && response.status < 500) {
    return { ok: false, reason: 'rejected' };
  }
  if (!response.ok) {
    // ⚠️ エラー本文をそのまま画面へ出さない。内部情報が混ざりうる。
    return { ok: false, reason: 'unavailable' };
  }

  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) {
    return { ok: false, reason: 'unavailable' };
  }
  return { ok: true, data: parsed.data };
}

function json(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

// --- 読み取り --------------------------------------------------------------

export function fetchMyArtworks(): Promise<
  CreatorResult<{ items: CreatorArtwork[]; nextCursor: string | null }>
> {
  return call('/api/v1/creator/artworks?limit=50', creatorArtworkListSchema);
}

export function fetchMyArtwork(id: string): Promise<CreatorResult<CreatorArtwork>> {
  return call(`/api/v1/creator/artworks/${encodeURIComponent(id)}`, adminArtworkSchema);
}

export function fetchMyListings(
  artworkId: string,
): Promise<CreatorResult<{ items: CreatorListing[]; nextCursor: string | null }>> {
  return call(
    `/api/v1/creator/artworks/${encodeURIComponent(artworkId)}/listings`,
    creatorListingListSchema,
  );
}

// --- 書き込み --------------------------------------------------------------

export function createArtwork(input: {
  slug: string;
  title: string;
  description?: string;
  maxSupply: number;
}): Promise<CreatorResult<CreatorArtwork>> {
  return call('/api/v1/creator/artworks', adminArtworkSchema, json(input));
}

/**
 * 画像を登録する。
 *
 * ⚠️ **生のバイト列で送る。** multipart にしないのは、境界の解析を
 * 増やさないため。種別の判定は API 側が**中身のマジックナンバー**で行う。
 * ここで渡す `contentType` は照合にしか使われない。
 */
export function uploadArtworkImage(
  artworkId: string,
  bytes: ArrayBuffer,
  contentType: string,
): Promise<CreatorResult<{ imageKey: string; imageUrl: string }>> {
  return call(
    `/api/v1/creator/artworks/${encodeURIComponent(artworkId)}/image`,
    uploadImageResponseSchema,
    { method: 'POST', headers: { 'content-type': contentType }, body: bytes },
  );
}

export function publishArtwork(id: string): Promise<CreatorResult<CreatorArtwork>> {
  return call(`/api/v1/creator/artworks/${encodeURIComponent(id)}/publish`, adminArtworkSchema, {
    method: 'POST',
  });
}

export function archiveArtwork(id: string): Promise<CreatorResult<CreatorArtwork>> {
  return call(`/api/v1/creator/artworks/${encodeURIComponent(id)}/archive`, adminArtworkSchema, {
    method: 'POST',
  });
}

export function createListing(input: {
  artworkId: string;
  priceAmount: number;
  priceCurrency: string;
  maxQuantityPerOrder?: number;
}): Promise<CreatorResult<CreatorListing>> {
  return call('/api/v1/creator/listings', adminListingSchema, json(input));
}

export function activateListing(id: string): Promise<CreatorResult<CreatorListing>> {
  return call(`/api/v1/creator/listings/${encodeURIComponent(id)}/activate`, adminListingSchema, {
    method: 'POST',
  });
}

export function suspendListing(id: string): Promise<CreatorResult<CreatorListing>> {
  return call(`/api/v1/creator/listings/${encodeURIComponent(id)}/suspend`, adminListingSchema, {
    method: 'POST',
  });
}
