import { legalConsentStatusSchema, type LegalConsentStatus } from '@sengoku/contracts';
import { getWebEnv } from './env';
import { currentAccessToken } from './auth/current';

/**
 * 規約への同意（`UD-126`）。
 *
 * ⚠️ **サーバー側でのみ使う。** 資格情報をブラウザへ渡さない。
 *
 * ⚠️ **同意を求めるのは利用規約だけ。** プライバシーポリシーを同じ
 * チェックへ束ねない。個人情報保護法では利用目的は原則「公表」で足り、
 * 「同意」が要るのは第三者提供などの場面。
 */

export type ConsentResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly reason: 'unauthenticated' | 'unavailable' | 'rejected';
      readonly code?: string;
    };

const TIMEOUT_MS = 8000;

async function call(path: string, init: RequestInit = {}): Promise<Response | null> {
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
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function parse(response: Response | null): Promise<ConsentResult<LegalConsentStatus>> {
  if (response === null) {
    return { ok: false, reason: 'unauthenticated' };
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: 'unauthenticated' };
    }
    let code: string | undefined;
    try {
      const body: unknown = await response.json();
      const error = (body as { error?: { code?: unknown } }).error;
      code = typeof error?.code === 'string' ? error.code : undefined;
    } catch {
      code = undefined;
    }
    return { ok: false, reason: response.status < 500 ? 'rejected' : 'unavailable', code };
  }
  const parsed = legalConsentStatusSchema.safeParse(await response.json());
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, reason: 'unavailable' };
}

export async function fetchConsentStatus(): Promise<ConsentResult<LegalConsentStatus>> {
  return parse(await call('/api/v1/legal-consent'));
}

export async function recordConsent(versionId: string): Promise<ConsentResult<LegalConsentStatus>> {
  return parse(
    await call('/api/v1/legal-consent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ versionId }),
    }),
  );
}

/**
 * ログインの直後に、同意を求めるべきか。
 *
 * ⚠️ **引き換えたばかりのトークンを受け取る。** この時点ではまだ Cookie を
 * 書いていないので、`currentAccessToken()` からは読めない。
 *
 * ⚠️ **確かめられないときは求めない。** API が落ちているときに同意画面へ
 * 送ると、ログインした人がそこから先へ進めなくなる。**確認できないことを
 * 理由に締め出さない。** 同意の記録が 1 回遅れるより、入れないほうが重い。
 */
export async function consentRequired(accessToken: string): Promise<boolean> {
  const { WEB_API_BASE_URL } = getWebEnv();
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, TIMEOUT_MS);
  try {
    const response = await fetch(`${WEB_API_BASE_URL}/api/v1/legal-consent`, {
      signal: controller.signal,
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      cache: 'no-store',
    });
    if (!response.ok) {
      return false;
    }
    const parsed = legalConsentStatusSchema.safeParse(await response.json());
    return parsed.success && parsed.data.required;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
