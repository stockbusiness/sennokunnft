import {
  adminArtworkSchema,
  adminListingSchema,
  creatorEarningsDetailResponseSchema,
  creatorEarningsResponseSchema,
  creatorProfileDetailSchema,
  payoutAccountResponseSchema,
  creatorProfileSchema,
  uploadImageResponseSchema,
  type CreatorArtwork,
  type CreatorEarningsDetailResponse,
  type CreatorEarningsResponse,
  type CreatorListing,
  type CreatorProfileDetailView,
  type PayoutAccountResponse,
  type CreatorProfileView,
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

export type CreatorFailureReason = 'unauthorized' | 'not_found' | 'rejected' | 'unavailable';

export type CreatorResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly reason: CreatorFailureReason;
      /**
       * `{ error: { code } }` の符号。
       *
       * ⚠️ **画面へ出す言葉は web 側で決める。** API の `message` は読まない。
       * 本文をそのまま流すと、いつか内部の詳細が画面に出る。符号だけを見て、
       * 直し方の違う失敗（「すでに使われている」と「運営とまぎらわしい」）を
       * 区別する。
       */
      readonly code?: string;
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
    // ⚠️ エラー本文はそのまま画面へ出さない。符号だけを取り出す。
    return { ok: false, reason: 'rejected', ...(await errorCodeOf(response)) };
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

/**
 * `{ error: { code } }` の符号だけを取り出す。
 *
 * ⚠️ **`message` は読まない。** 画面へ出す言葉は web 側で決める。
 * 見つからなければ何も足さない（`code` の欄自体を作らない）。
 */
async function errorCodeOf(response: Response): Promise<{ code?: string }> {
  try {
    const body: unknown = await response.json();
    const error = (body as { error?: { code?: unknown } }).error;
    return typeof error?.code === 'string' ? { code: error.code } : {};
  } catch {
    return {};
  }
}

function json(body: unknown, method: 'POST' | 'PUT' = 'POST'): RequestInit {
  return {
    method,
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

// --- 自分のプロフィール（決定 2026-08-20）--------------------------------

/**
 * 自分の表示名を読む。
 *
 * ⚠️ **誰の分かを渡さない。** API はトークンから決める。渡せる形にすると、
 * そこが他人の名前を書き換える道になる。
 */
export function fetchMyProfile(): Promise<CreatorResult<CreatorProfileView>> {
  return call('/api/v1/creator/profile', creatorProfileSchema);
}

/** 自分の表示名を決める・変える。 */
export function updateMyProfile(displayName: string): Promise<CreatorResult<CreatorProfileView>> {
  return call('/api/v1/creator/profile', creatorProfileSchema, json({ displayName }, 'PUT'));
}

// --- 売上とプロフィール（P1-2）------------------------------------------

/*
  ⚠️ **どの口にも「誰の分か」を渡さない。** アカウントは API 側が
     トークンから取る。ここで渡せる形にすると、そこが他人の売上を
     覗く道になる——売上は、その方の商いの中身そのものである。
*/

export function fetchMyEarnings(): Promise<CreatorResult<CreatorEarningsResponse>> {
  return call('/api/v1/creator/earnings', creatorEarningsResponseSchema);
}

/** ある期間の明細。⚠️ 省略なら進行中の期間。 */
export function fetchMyEarningsDetail(
  periodKey?: string,
): Promise<CreatorResult<CreatorEarningsDetailResponse>> {
  const query = periodKey === undefined ? '' : `?periodKey=${encodeURIComponent(periodKey)}`;
  return call(`/api/v1/creator/earnings/detail${query}`, creatorEarningsDetailResponseSchema);
}

export function fetchMyProfileDetail(): Promise<CreatorResult<CreatorProfileDetailView>> {
  return call('/api/v1/creator/profile/detail', creatorProfileDetailSchema);
}

export function saveMyProfileDetail(input: {
  shopName: string | null;
  bio: string | null;
  links: readonly { label: string; url: string }[];
  invoiceNumber: string | null;
}): Promise<CreatorResult<CreatorProfileDetailView>> {
  return call('/api/v1/creator/profile/detail', creatorProfileDetailSchema, json(input, 'PUT'));
}

/**
 * 明細の CSV。
 *
 * ⚠️ **`call()` を使わない。** あちらは JSON を前提に スキーマで検証する。
 * CSV はそのまま渡す。
 *
 * ⚠️ **本文を画面へ埋め込まない。** 受け取ったものを、そのまま
 * ダウンロードとして返す（route handler 側）。
 */
export async function fetchMyEarningsCsv(
  periodKey?: string,
): Promise<CreatorResult<{ body: string }>> {
  const token = await creatorToken();
  if (token === null) {
    return { ok: false, reason: 'unauthorized' };
  }
  const query = periodKey === undefined ? '' : `?periodKey=${encodeURIComponent(periodKey)}`;
  const { WEB_API_BASE_URL } = getWebEnv();
  let response: Response;
  try {
    response = await fetch(`${WEB_API_BASE_URL}/api/v1/creator/earnings/csv${query}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'text/csv' },
      cache: 'no-store',
    });
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: 'unauthorized' };
  }
  if (response.status >= 400 && response.status < 500) {
    return { ok: false, reason: 'rejected', ...(await errorCodeOf(response)) };
  }
  if (!response.ok) {
    return { ok: false, reason: 'unavailable' };
  }
  return { ok: true, data: { body: await response.text() } };
}

// --- お振込先（P1-3・`UD-124` 決定 2026-08-21）---------------------------

/*
  ⚠️ **どちらの口にも「誰の分か」を渡さない。** アカウントは API 側が
     トークンから取る。渡せる形にすると、**そこが他人の支払先を差し替える
     道になる**——この仕組みでいちばん実入りのある攻撃である。
*/

export function fetchMyPayoutAccount(): Promise<CreatorResult<PayoutAccountResponse>> {
  return call('/api/v1/creator/payout-account', payoutAccountResponseSchema);
}

export function saveMyPayoutAccount(input: {
  bankName: string;
  branchName: string;
  accountType: 'ordinary' | 'checking';
  accountNumber: string;
  accountHolderKana: string;
}): Promise<CreatorResult<PayoutAccountResponse>> {
  return call('/api/v1/creator/payout-account', payoutAccountResponseSchema, json(input, 'PUT'));
}
