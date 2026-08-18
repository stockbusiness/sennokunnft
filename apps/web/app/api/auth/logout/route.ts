import { NextResponse, type NextRequest } from 'next/server';
import { SupabaseAuthGateway } from '../../../../src/auth/gateway';
import { clearSession } from '../../../../src/auth/cookies';
import { ACCESS_COOKIE } from '../../../../src/auth/session';
import { getWebEnv } from '../../../../src/env';
import { siteRedirect } from '../../../../src/redirect';

/**
 * ログアウト。
 *
 * ⚠️ **GET では受けない。** 画像やリンクを踏ませるだけで
 * 他人をログアウトさせられる（CSRF）。実害は小さいが、
 * 「他人の操作を勝手に起こせる経路」を作らない。
 *
 * ⚠️ **相手側が失敗しても Cookie は必ず消す。**
 * 手元に残るほうが害が大きい。
 */
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const env = getWebEnv();
  const token = request.cookies.get(ACCESS_COOKIE)?.value;

  if (
    token !== undefined &&
    token !== '' &&
    env.SUPABASE_URL !== undefined &&
    env.SUPABASE_ANON_KEY !== undefined
  ) {
    const gateway = new SupabaseAuthGateway({
      url: env.SUPABASE_URL,
      anonKey: env.SUPABASE_ANON_KEY,
    });
    await gateway.signOut(token);
  }

  const response = siteRedirect('/', { status: 303 });
  clearSession(response.cookies);
  return response;
}
