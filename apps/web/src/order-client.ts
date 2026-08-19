import { orderViewSchema, type OrderView } from '@sengoku/contracts';
import { getWebEnv } from './env';
import { currentAccessToken } from './auth/current';

/**
 * 購入者向けの注文 API の呼び出し。
 *
 * ⚠️ **サーバー側でのみ使う。** 資格情報をブラウザへ渡さない。
 *
 * ⚠️ **金額を送らない。** 送るのは出品IDと重複防止キーだけ。
 * ここに金額を足せてしまうと、画面の値をそのまま信じる実装がいつか現れる。
 */

export type OrderResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly reason: 'unauthenticated' | 'not_found' | 'unavailable' | 'rejected';
      /** API が返した符号。⚠️ 本文の文言は読まない。画面の言葉は web 側で決める。 */
      readonly code?: string;
    };

const TIMEOUT_MS = 8000;

async function errorCode(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    const error = (body as { error?: { code?: unknown } }).error;
    return typeof error?.code === 'string' ? error.code : undefined;
  } catch {
    return undefined;
  }
}

async function call(path: string, init: RequestInit): Promise<Response | 'unreachable' | null> {
  const token = await currentAccessToken();
  if (token === null) {
    return null;
  }
  const { WEB_API_BASE_URL } = getWebEnv();
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, TIMEOUT_MS);
  try {
    return await fetch(`${WEB_API_BASE_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        ...init.headers,
        authorization: `Bearer ${token}`,
        accept: 'application/json',
      },
      cache: 'no-store',
    });
  } catch {
    return 'unreachable';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 注文を作る。
 *
 * @param idempotencyKey 画面が作る重複防止キー。
 * ⚠️ **押すたびに作り直さない。** 確認画面を開いたときに 1 個作り、
 * 二重に押されても同じキーを送る。そうしないと、二度押しで注文が 2 件できる。
 */
export async function createOrder(input: {
  readonly listingId: string;
  readonly idempotencyKey: string;
}): Promise<OrderResult<OrderView>> {
  const response = await call('/api/v1/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ listingId: input.listingId, idempotencyKey: input.idempotencyKey }),
  });
  if (response === null) {
    return { ok: false, reason: 'unauthenticated' };
  }
  if (response === 'unreachable') {
    return { ok: false, reason: 'unavailable' };
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: 'unauthenticated' };
    }
    if (response.status === 404) {
      return { ok: false, reason: 'not_found', code: await errorCode(response) };
    }
    if (response.status >= 400 && response.status < 500) {
      return { ok: false, reason: 'rejected', code: await errorCode(response) };
    }
    return { ok: false, reason: 'unavailable' };
  }

  const body: unknown = await response.json();
  const parsed = orderViewSchema.safeParse((body as { order?: unknown }).order);
  if (!parsed.success) {
    return { ok: false, reason: 'unavailable' };
  }
  return { ok: true, data: parsed.data };
}

export async function fetchOrder(orderId: string): Promise<OrderResult<OrderView>> {
  const response = await call(`/api/v1/orders/${encodeURIComponent(orderId)}`, { method: 'GET' });
  if (response === null) {
    return { ok: false, reason: 'unauthenticated' };
  }
  if (response === 'unreachable') {
    return { ok: false, reason: 'unavailable' };
  }
  if (response.status === 404) {
    // ⚠️ 他人の注文もここに来る。存在の有無を区別しない。
    return { ok: false, reason: 'not_found' };
  }
  if (!response.ok) {
    return {
      ok: false,
      reason:
        response.status === 401 || response.status === 403 ? 'unauthenticated' : 'unavailable',
    };
  }

  const parsed = orderViewSchema.safeParse(await response.json());
  if (!parsed.success) {
    return { ok: false, reason: 'unavailable' };
  }
  return { ok: true, data: parsed.data };
}

/**
 * 断られた理由を、利用者向けの言葉に置き換える。
 *
 * ⚠️ **符号をそのまま出さない。** 出しても利用者にできることは無い。
 * 伝えるのは「次に何をすればよいか」だけ。
 */
export function orderErrorMessage(result: {
  readonly reason: 'unauthenticated' | 'not_found' | 'unavailable' | 'rejected';
  readonly code?: string;
}): string {
  if (result.reason === 'unauthenticated') {
    return 'お申し込みにはログインが必要です。ログインのうえ、もう一度お試しください。';
  }
  if (result.reason === 'not_found') {
    return 'お探しの作品が見つかりませんでした。一覧からもう一度お選びください。';
  }
  if (result.reason === 'rejected') {
    if (result.code === 'INSUFFICIENT_SUPPLY') {
      return '申し訳ありません。ちょうど売り切れてしまいました。';
    }
    if (result.code === 'LISTING_NOT_ACTIVE' || result.code === 'ARTWORK_NOT_PUBLISHED') {
      return 'ただいまこの作品はお取り扱いしておりません。';
    }
    if (result.code === 'IDEMPOTENCY_CONFLICT') {
      return '先ほどのお手続きとは別の作品が指定されました。お手数ですが、作品のページからやり直してください。';
    }
    return 'ただいまお手続きできませんでした。少し時間をおいて、もう一度お試しください。';
  }
  return 'ただいまお手続きできませんでした。少し時間をおいて、もう一度お試しください。';
}
