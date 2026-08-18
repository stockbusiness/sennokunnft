import type { NextResponse } from 'next/server';
import { ACCESS_COOKIE, EXPIRES_COOKIE, REFRESH_COOKIE, type Session } from './session';

/**
 * ログイン状態を Cookie に置く／消す。
 *
 * ⚠️ **`httpOnly` を外さない。** JavaScript から読めるようにした瞬間、
 * XSS が 1 つ見つかれば全利用者のトークンが持ち出される。
 *
 * ⚠️ **`SameSite=Lax` にする。** `None` にすると、他所のサイトに
 * 貼られたフォームからでも Cookie が付いて飛ぶ。
 */
export interface CookieTarget {
  set(name: string, value: string, options: Record<string, unknown>): unknown;
  delete(name: string): unknown;
}

function baseOptions(secure: boolean, maxAgeSec: number) {
  return {
    httpOnly: true,
    // ⚠️ 手元の http でも試せるように、https のときだけ secure を付ける。
    secure,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: maxAgeSec,
  };
}

/**
 * ログイン状態を書き込む。
 *
 * `EXPIRES_COOKIE` だけ `httpOnly` を付けないのではなく、**付ける**。
 * 期限は画面側で使わない。middleware とサーバー側の判定にしか要らない。
 */
export function writeSession(cookies: CookieTarget, session: Session, secure: boolean): void {
  // 取り直し用は長め、利用者向けは短め。
  const refreshMaxAge = 30 * 24 * 60 * 60;
  const accessMaxAge = Math.max(60, session.expiresAt - Math.floor(Date.now() / 1000));

  cookies.set(ACCESS_COOKIE, session.accessToken, baseOptions(secure, accessMaxAge));
  cookies.set(REFRESH_COOKIE, session.refreshToken, baseOptions(secure, refreshMaxAge));
  cookies.set(EXPIRES_COOKIE, String(session.expiresAt), baseOptions(secure, refreshMaxAge));
}

/**
 * ログイン状態を消す。
 *
 * ⚠️ **3 つとも消す。** 1 つでも残ると「途中まで入っている」状態になり、
 * 入り直しても古い値を拾って直らないことがある。
 */
export function clearSession(cookies: CookieTarget): void {
  cookies.delete(ACCESS_COOKIE);
  cookies.delete(REFRESH_COOKIE);
  cookies.delete(EXPIRES_COOKIE);
}

export function writeSessionToResponse(
  response: NextResponse,
  session: Session,
  secure: boolean,
): NextResponse {
  writeSession(response.cookies, session, secure);
  return response;
}
