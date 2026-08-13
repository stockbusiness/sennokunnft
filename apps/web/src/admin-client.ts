import {
  adminArtworkListResponseSchema,
  adminArtworkSchema,
  adminListingListResponseSchema,
  adminListingSchema,
  type AdminArtwork,
  type AdminArtworkListResponse,
  type AdminListing,
  type AdminListingListResponse,
} from '@sengoku/contracts';
import { z } from '@sengoku/validation';
import { getWebEnv } from './env';

/**
 * 管理 API の呼び出し。
 *
 * ⚠️ **サーバー側でのみ使う。** 資格情報をブラウザへ渡さないため。
 *
 * ⚠️ **画面を隠すことは保護ではない。**
 * 管理画面を出さなくても API は直接叩ける。認可は必ず API 側で判定する。
 * ここは「操作するための入口」を用意しているだけで、
 * 権限が無ければサーバーが 401/403 を返す。
 */

/**
 * 運営の資格情報。
 *
 * Phase 2 では認証プロバイダへ本接続しないため、
 * サーバー側の環境変数で渡された開発用トークンを使う（`UD-801` が未決定）。
 * 本番で開発用の検証方式が有効にならないことは、
 * API 側の起動時ガードが保証している。
 */
function operatorToken(): string | null {
  const token = getWebEnv().ADMIN_DEV_TOKEN;
  return token === undefined || token === '' ? null : token;
}

export type AdminResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly reason: 'unauthorized' | 'not_found' | 'unavailable';
      readonly message?: string;
    };

async function callAdmin<T>(
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit = {},
): Promise<AdminResult<T>> {
  const token = operatorToken();
  if (token === null) {
    return { ok: false, reason: 'unauthorized', message: '運営用の資格情報が設定されていません。' };
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
  if (!response.ok) {
    // エラー本文はそのまま画面へ出さない。内部情報が混ざりうるため。
    return { ok: false, reason: 'unavailable' };
  }

  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) {
    return { ok: false, reason: 'unavailable' };
  }
  return { ok: true, data: parsed.data };
}

export function fetchAdminArtworks(): Promise<AdminResult<AdminArtworkListResponse>> {
  return callAdmin('/api/v1/admin/artworks?limit=50', adminArtworkListResponseSchema);
}

export function fetchAdminArtwork(id: string): Promise<AdminResult<AdminArtwork>> {
  return callAdmin(`/api/v1/admin/artworks/${encodeURIComponent(id)}`, adminArtworkSchema);
}

export function fetchAdminListings(): Promise<AdminResult<AdminListingListResponse>> {
  return callAdmin('/api/v1/admin/listings?limit=50', adminListingListResponseSchema);
}

export function fetchAdminListing(id: string): Promise<AdminResult<AdminListing>> {
  return callAdmin(`/api/v1/admin/listings/${encodeURIComponent(id)}`, adminListingSchema);
}
