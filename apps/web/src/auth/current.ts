import { cookies } from 'next/headers';
import { ACCESS_COOKIE, EXPIRES_COOKIE, isExpired } from './session';

/**
 * いま操作している人のトークン。
 *
 * ⚠️ **期限切れを黙って返さない。** 返すと api が 401 を返し、
 * 画面には「権限がありません」と出る。利用者からは、自分の権限が
 * 消えたように見えて、原因が分からない。切れているなら「未ログイン」
 * として扱い、ログインへ案内する。
 *
 * ⚠️ **ここでは取り直しをしない。** Cookie の書き込みは
 * Server Component からは行えない。取り直しは middleware の仕事。
 */
export async function currentAccessToken(): Promise<string | null> {
  const store = await cookies();
  const token = store.get(ACCESS_COOKIE)?.value;
  if (token === undefined || token === '') {
    return null;
  }

  const expiresAt = Number.parseInt(store.get(EXPIRES_COOKIE)?.value ?? '', 10);
  if (Number.isSafeInteger(expiresAt) && isExpired(expiresAt, Math.floor(Date.now() / 1000))) {
    return null;
  }
  return token;
}

export async function isLoggedIn(): Promise<boolean> {
  return (await currentAccessToken()) !== null;
}
