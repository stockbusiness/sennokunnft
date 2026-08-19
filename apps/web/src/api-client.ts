import {
  artworkDetailSchema,
  artworkListResponseSchema,
  publicListingSchema,
  type ArtworkDetail,
  type ArtworkListResponse,
  type PublicListing,
} from '@sengoku/contracts';
import { getWebEnv } from './env';

/**
 * API 呼び出し。
 *
 * ⚠️ **サーバー側でのみ使う。** ブラウザから直接 API を叩かないのは、
 * 将来アクセストークンを httpOnly Cookie に閉じ込めるため
 * （AUTHORIZATION_DESIGN.md §1.4）。
 *
 * ⚠️ **応答をスキーマで検証する。** 相手が同じリポジトリの API でも、
 * 版ずれやデプロイの前後関係で形が違うことはある。
 * 検証せずに描画すると、画面が意味不明な壊れ方をする。
 */

/** API が落ちているときの表現。画面を落とさず、状態として扱う。 */
export type FetchResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly reason: 'unavailable' | 'not_found' | 'invalid_response' };

const DEFAULT_TIMEOUT_MS = 5000;

async function fetchJson(path: string): Promise<Response | null> {
  const { WEB_API_BASE_URL } = getWebEnv();
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, DEFAULT_TIMEOUT_MS);

  try {
    return await fetch(`${WEB_API_BASE_URL}${path}`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
      // カタログは頻繁に変わらないが、公開・売り切れの反映が遅れると
      // 「買えない物が買えるように見える」ので、都度取得する。
      cache: 'no-store',
    });
  } catch {
    // タイムアウト・接続失敗。理由の詳細は画面に出さない。
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchArtworkList(limit = 24): Promise<FetchResult<ArtworkListResponse>> {
  const response = await fetchJson(`/api/v1/artworks?limit=${String(limit)}`);
  if (response === null || !response.ok) {
    return { ok: false, reason: 'unavailable' };
  }

  const parsed = artworkListResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    return { ok: false, reason: 'invalid_response' };
  }
  return { ok: true, data: parsed.data };
}

export async function fetchArtworkDetail(slug: string): Promise<FetchResult<ArtworkDetail>> {
  const response = await fetchJson(`/api/v1/artworks/${encodeURIComponent(slug)}`);
  if (response === null) {
    return { ok: false, reason: 'unavailable' };
  }
  if (response.status === 404) {
    return { ok: false, reason: 'not_found' };
  }
  if (!response.ok) {
    return { ok: false, reason: 'unavailable' };
  }

  const parsed = artworkDetailSchema.safeParse(await response.json());
  if (!parsed.success) {
    return { ok: false, reason: 'invalid_response' };
  }
  return { ok: true, data: parsed.data };
}

/**
 * 出品の詳細（購入手続きの確認画面で使う）。
 *
 * ⚠️ **ここで得た価格を注文へ送らない。** 表示のためだけに使う。
 * 金額はサーバーが DB から決める（指示書 §4.2）。
 */
export async function fetchPublicListing(id: string): Promise<FetchResult<PublicListing>> {
  const response = await fetchJson(`/api/v1/listings/${encodeURIComponent(id)}`);
  if (response === null) {
    return { ok: false, reason: 'unavailable' };
  }
  if (response.status === 404) {
    // 下書きの出品・非公開作品の出品もここに来る。存在を区別しない。
    return { ok: false, reason: 'not_found' };
  }
  if (!response.ok) {
    return { ok: false, reason: 'unavailable' };
  }

  const parsed = publicListingSchema.safeParse(await response.json());
  if (!parsed.success) {
    return { ok: false, reason: 'invalid_response' };
  }
  return { ok: true, data: parsed.data };
}
