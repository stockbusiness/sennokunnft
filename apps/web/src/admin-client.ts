import {
  staffListResponseSchema,
  staffInvitationSchema,
  staffMemberSchema,
  type CreateStaffInvitationRequest,
  type StaffInvitationView,
  type StaffListResponse,
  type StaffMemberView,
  type UpdateStaffMemberRequest,
  adminArtworkListResponseSchema,
  adminArtworkSchema,
  adminListingListResponseSchema,
  adminListingSchema,
  uploadImageResponseSchema,
  type AdminArtwork,
  type AdminArtworkListResponse,
  type AdminListing,
  type AdminListingListResponse,
} from '@sengoku/contracts';
import { z } from '@sengoku/validation';
import { getWebEnv } from './env';
import { currentAccessToken } from './auth/current';

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

export type AdminResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly reason: 'unauthorized' | 'not_found' | 'rejected' | 'unavailable';
      readonly message?: string;
      /**
       * API が返した符号（`{ error: { code } }`）。
       *
       * ⚠️ **本文の文言をそのまま画面へ出さない。** 内部情報が混ざりうる。
       * 画面へ出す言葉は、こちらの符号から**web 側で**引き当てる。
       * 符号だけなら、何が起きたかを伝えつつ、中身は漏れない。
       */
      readonly code?: string;
    };

/**
 * 運営の資格情報（環境変数の共有トークン）。
 *
 * ⚠️ **これは 1 本しか無く、使った全員が同じ人として扱われる。**
 * 監査ログの「誰が」がひとつに潰れる。
 *
 * ⚠️ **ログイン機能が有効な環境では使わない**（2026-08-18 に変更）。
 * 以前は「ログインが断られたときの逃げ道」として残していたが、それだと
 * `SUPABASE_*` を外したときに**黙って「全員が同じ人」へ戻る**。
 * 静かに弱くなる経路は、いつか誰も気づかないまま本番に残る。
 *
 * 残してあるのは、ログイン機能を有効にしていない手元のため。
 * `SUPABASE_URL` と `SUPABASE_ANON_KEY` が入っていれば、こちらは使われない。
 * これは出品者向け（`creator-client`）と同じ規則にそろえてある。
 */
function sharedOperatorToken(): string | null {
  const env = getWebEnv();
  if (env.SUPABASE_URL !== undefined && env.SUPABASE_ANON_KEY !== undefined) {
    return null;
  }
  const token = env.ADMIN_DEV_TOKEN;
  return token === undefined || token === '' ? null : token;
}

/**
 * 使う資格情報を、優先順に並べる。
 *
 * ⚠️ **ログイン済みなら、まずその人のトークンを試す。**
 * 共有トークンを先に使うと、誰が操作したのかが監査ログに残らない。
 *
 * ⚠️ **ログイン機能が有効な環境では、共有トークンが並びに入らない。**
 * `sharedOperatorToken` が `null` を返すため、本番では実質この 1 本だけ。
 * 手元（ログイン未設定）では今までどおり共有トークンが使える。
 */
async function credentials(): Promise<string[]> {
  const tokens: string[] = [];
  const session = await currentAccessToken();
  if (session !== null) {
    tokens.push(session);
  }
  const shared = sharedOperatorToken();
  if (shared !== null) {
    tokens.push(shared);
  }
  return tokens;
}

/**
 * `{ error: { code } }` の符号だけを取り出す。
 *
 * ⚠️ **`message` は読まない。** 画面へ出す言葉は web 側で決める。
 * 本文をそのまま流すと、いつか内部の詳細が画面に出る。
 */
async function errorCode(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    const error = (body as { error?: { code?: unknown } }).error;
    return typeof error?.code === 'string' ? error.code : undefined;
  } catch {
    return undefined;
  }
}

/** 応答の状態コードを、画面が扱える理由に翻訳する。 */
function reasonFor(status: number): 'unauthorized' | 'not_found' | 'rejected' | 'unavailable' {
  if (status === 401 || status === 403) {
    return 'unauthorized';
  }
  if (status === 404) {
    return 'not_found';
  }
  if (status >= 400 && status < 500) {
    // 入力の誤りと、こちら側の不調を分ける。利用者に見せる言葉が違うため。
    return 'rejected';
  }
  return 'unavailable';
}

async function callAdmin<T>(
  path: string,
  schema: z.ZodType<T> | null,
  init: RequestInit = {},
): Promise<AdminResult<T>> {
  const tokens = await credentials();
  if (tokens.length === 0) {
    return { ok: false, reason: 'unauthorized', message: '運営用の資格情報が設定されていません。' };
  }

  const { WEB_API_BASE_URL } = getWebEnv();
  let lastReason: 'unauthorized' | 'not_found' | 'rejected' | 'unavailable' = 'unauthorized';

  for (const token of tokens) {
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

    if (!response.ok) {
      lastReason = reasonFor(response.status);
      // 断られたときだけ次の資格情報を試す。それ以外は理由が変わらない。
      if (lastReason === 'unauthorized') {
        continue;
      }
      // ⚠️ エラー本文はそのまま画面へ出さない。符号だけを取り出す。
      return { ok: false, reason: lastReason, code: await errorCode(response) };
    }

    if (schema === null) {
      // 204 のように本文を返さない応答。読み取ろうとしない。
      return { ok: true, data: undefined as T };
    }

    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) {
      return { ok: false, reason: 'unavailable' };
    }
    return { ok: true, data: parsed.data };
  }

  return { ok: false, reason: lastReason };
}

function json(body: unknown, method: 'POST' | 'PATCH'): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

// --- 読み取り --------------------------------------------------------------

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

/** 指定した作品の出品だけを取る。詳細画面で販売状態を見せるため。 */
export function fetchAdminListingsOfArtwork(
  artworkId: string,
): Promise<AdminResult<AdminListingListResponse>> {
  return callAdmin(
    `/api/v1/admin/listings?limit=50&artworkId=${encodeURIComponent(artworkId)}`,
    adminListingListResponseSchema,
  );
}

// --- 書き込み --------------------------------------------------------------

export function updateAdminArtwork(
  id: string,
  input: { title?: string; description?: string; maxSupply?: number },
): Promise<AdminResult<AdminArtwork>> {
  return callAdmin(
    `/api/v1/admin/artworks/${encodeURIComponent(id)}`,
    adminArtworkSchema,
    json(input, 'PATCH'),
  );
}

/**
 * 画像を差し替える。
 *
 * ⚠️ **生のバイト列で送る。** multipart にしないのは、境界の解析を
 * 増やさないため。種別の判定は API 側が**中身のマジックナンバー**で行う。
 */
export function uploadAdminArtworkImage(
  id: string,
  bytes: ArrayBuffer,
  contentType: string,
): Promise<AdminResult<{ imageKey: string; imageUrl: string }>> {
  return callAdmin(
    `/api/v1/admin/artworks/${encodeURIComponent(id)}/image`,
    uploadImageResponseSchema,
    {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: bytes,
    },
  );
}

export function publishAdminArtwork(id: string): Promise<AdminResult<AdminArtwork>> {
  return callAdmin(`/api/v1/admin/artworks/${encodeURIComponent(id)}/publish`, adminArtworkSchema, {
    method: 'POST',
  });
}

export function archiveAdminArtwork(id: string): Promise<AdminResult<AdminArtwork>> {
  return callAdmin(`/api/v1/admin/artworks/${encodeURIComponent(id)}/archive`, adminArtworkSchema, {
    method: 'POST',
  });
}

/**
 * 作品を完全に消す。
 *
 * ⚠️ **元に戻せない。** 呼ぶ前に、画面側で必ず確認を挟むこと。
 * 応答は 204（本文なし）なので、読み取るスキーマを渡さない。
 */
export function deleteAdminArtwork(id: string): Promise<AdminResult<undefined>> {
  return callAdmin<undefined>(`/api/v1/admin/artworks/${encodeURIComponent(id)}`, null, {
    method: 'DELETE',
  });
}

export function suspendAdminListing(id: string): Promise<AdminResult<AdminListing>> {
  return callAdmin(`/api/v1/admin/listings/${encodeURIComponent(id)}/suspend`, adminListingSchema, {
    method: 'POST',
  });
}

export function endAdminListing(id: string): Promise<AdminResult<AdminListing>> {
  return callAdmin(`/api/v1/admin/listings/${encodeURIComponent(id)}/end`, adminListingSchema, {
    method: 'POST',
  });
}

// --- 運営スタッフ（`UD-803`）------------------------------------------------
//
// ⚠️ **これらはオーナーの印を持つ人しか通らない。** 印が無ければ API が
//    403 を返し、画面には「権限がありません」と出る。画面側で隠すのは
//    導線を分かりやすくするためであって、保護ではない。

export function fetchStaff(): Promise<AdminResult<StaffListResponse>> {
  return callAdmin('/api/v1/admin/staff', staffListResponseSchema);
}

export function inviteStaff(
  request: CreateStaffInvitationRequest,
): Promise<AdminResult<StaffInvitationView>> {
  return callAdmin('/api/v1/admin/staff/invitations', staffInvitationSchema, json(request, 'POST'));
}

export function revokeStaffInvitation(id: string): Promise<AdminResult<StaffInvitationView>> {
  return callAdmin(
    `/api/v1/admin/staff/invitations/${encodeURIComponent(id)}`,
    staffInvitationSchema,
    { method: 'DELETE' },
  );
}

export function updateStaffMember(
  accountId: string,
  request: UpdateStaffMemberRequest,
): Promise<AdminResult<StaffMemberView>> {
  return callAdmin(
    `/api/v1/admin/staff/${encodeURIComponent(accountId)}`,
    staffMemberSchema,
    json(request, 'PATCH'),
  );
}
