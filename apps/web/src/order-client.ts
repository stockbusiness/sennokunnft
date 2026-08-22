import {
  buyerOrderListResponseSchema,
  checkoutSessionResponseSchema,
  collectibleListResponseSchema,
  orderViewSchema,
  type BuyerOrderListResponse,
  type CheckoutSessionResponse,
  type CollectibleListResponse,
  type OrderView,
} from '@sengoku/contracts';
import { z } from '@sengoku/validation';
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
 * ご自分のご注文の一覧（P0-3）。
 *
 * ⚠️ **誰の分かを渡さない。** API がトークンから決める。渡せる形にすると、
 * そこが他人の注文を覗く道になる。
 */
export async function fetchMyOrders(): Promise<OrderResult<BuyerOrderListResponse>> {
  return fetchList('/api/v1/orders', buyerOrderListResponseSchema);
}

/** ご自分が受け取ったものの一覧（P0-3）。⚠️ 同上、誰の分かは渡さない。 */
export async function fetchMyCollectibles(): Promise<OrderResult<CollectibleListResponse>> {
  return fetchList('/api/v1/collectibles', collectibleListResponseSchema);
}

/** 一覧を読む共通の手順。⚠️ 形が合わなければ握りつぶさず `unavailable` にする。 */
async function fetchList<T>(
  path: string,
  schema: { safeParse(value: unknown): { success: boolean; data?: T } },
): Promise<OrderResult<T>> {
  const response = await call(path, { method: 'GET' });
  if (response === null) {
    return { ok: false, reason: 'unauthenticated' };
  }
  if (response === 'unreachable') {
    return { ok: false, reason: 'unavailable' };
  }
  if (!response.ok) {
    return {
      ok: false,
      reason:
        response.status === 401 || response.status === 403 ? 'unauthenticated' : 'unavailable',
    };
  }
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success || parsed.data === undefined) {
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
    if (result.code === 'SALES_SETUP_INCOMPLETE') {
      // ⚠️ 内部の設定値を見せない（決定 C）。
      return '現在、この作品の購入準備を行っています。しばらくしてからもう一度お試しください。';
    }
    if (result.code === 'RESERVATION_EXPIRED') {
      return 'お取り置き時間が終了しました。作品ページから購入手続きをやり直してください。';
    }
    if (result.code === 'CHECKOUT_NOT_ALLOWED') {
      return 'このご注文は、いまお支払いにお進みいただけません。';
    }
    if (result.code === 'PAYMENT_PROVIDER_ERROR') {
      return 'ただいまお支払いのお手続きができませんでした。しばらくしてからお試しください。';
    }
    if (result.code === 'IDEMPOTENCY_CONFLICT') {
      return '先ほどのお手続きとは別の作品が指定されました。お手数ですが、作品のページからやり直してください。';
    }
    return 'ただいまお手続きできませんでした。少し時間をおいて、もう一度お試しください。';
  }
  return 'ただいまお手続きできませんでした。少し時間をおいて、もう一度お試しください。';
}

/**
 * 支払いの口を作り、送り先を受け取る。
 *
 * ⚠️ **本文を送らない。** 金額も通貨も、注文IDからサーバーが引く。
 * ここに項目を足した瞬間、ブラウザから金額を送れる道ができる。
 */
export async function createCheckoutSession(
  orderId: string,
): Promise<OrderResult<CheckoutSessionResponse>> {
  const response = await call(`/api/v1/orders/${encodeURIComponent(orderId)}/checkout-session`, {
    method: 'POST',
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
      return { ok: false, reason: 'not_found' };
    }
    if (response.status >= 400 && response.status < 500) {
      return { ok: false, reason: 'rejected', code: await errorCode(response) };
    }
    return { ok: false, reason: 'unavailable' };
  }

  const parsed = checkoutSessionResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    return { ok: false, reason: 'unavailable' };
  }
  return { ok: true, data: parsed.data };
}

/**
 * 返金のご相談（方針整理 2026-08-22）。
 *
 * ⚠️ **金額を送らない。** どれだけお返しするかは審査が決める。ここに
 * 金額の欄を作ると、打った額が約束に見える。
 *
 * ⚠️ **ご自分の注文かどうかは API が確かめる。** 他人の注文は「無い」と
 * 返ってくる（あることを教えない）。
 */
export async function submitRefundRequest(
  orderId: string,
  body: { readonly reason: string; readonly statement: string },
): Promise<OrderResult<{ readonly id: string }>> {
  const response = await call(`/api/v1/orders/${encodeURIComponent(orderId)}/refund-requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
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
      return { ok: false, reason: 'not_found' };
    }
    if (response.status >= 400 && response.status < 500) {
      return { ok: false, reason: 'rejected', code: await errorCode(response) };
    }
    return { ok: false, reason: 'unavailable' };
  }

  const parsed = z.object({ id: z.string() }).safeParse(await response.json());
  if (!parsed.success) {
    return { ok: false, reason: 'unavailable' };
  }
  return { ok: true, data: parsed.data };
}
