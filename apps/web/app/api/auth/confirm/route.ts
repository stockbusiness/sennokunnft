import { NextResponse, type NextRequest } from 'next/server';
import { SupabaseAuthGateway } from '../../../../src/auth/gateway';
import { safeReturnPath } from '../../../../src/auth/session';
import { writeSessionToResponse } from '../../../../src/auth/cookies';
import { claimStaffInvitation } from '../../../../src/auth/invitation';
import { getWebEnv } from '../../../../src/env';
import { isSecureRequest, siteRedirect } from '../../../../src/redirect';

/**
 * メールのリンクから戻ってきたところ。
 *
 * ⚠️ **`token_hash` 方式を使う。** 断片（`#`）でトークンを受け取る方式だと、
 * サーバーには届かず、ブラウザの JavaScript が触ることになる。
 * こちらなら**どのブラウザで開いても通る**。パソコンで申し込んで
 * スマホのメールで開く、という普通の使い方で失敗しない。
 *
 * ⚠️ **合図を Cookie へそのまま書かない。** 引き換えた結果だけを置く。
 */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const env = getWebEnv();
  const url = request.nextUrl;
  const next = safeReturnPath(url.searchParams.get('next'));

  if (env.SUPABASE_URL === undefined || env.SUPABASE_ANON_KEY === undefined) {
    return redirectToLogin(next);
  }

  const tokenHash = url.searchParams.get('token_hash');
  // Supabase が付ける種別。招待・変更など複数あるので、そのまま渡す。
  const type = url.searchParams.get('type') ?? 'magiclink';
  if (tokenHash === null || tokenHash === '') {
    return redirectToLogin(next);
  }

  const gateway = new SupabaseAuthGateway({
    url: env.SUPABASE_URL,
    anonKey: env.SUPABASE_ANON_KEY,
  });
  const result = await gateway.confirm(tokenHash, type);
  if (!result.ok) {
    // ⚠️ 何が起きたかを詳しく書かない。使い終わったリンクか、
    //    偽のリンクかを外に教えない。案内は「もう一度お送りください」で足りる。
    return redirectToLogin(next);
  }

  // 招待されていた人なら、ここでスタッフになる（`UD-803`）。
  // ⚠️ **失敗してもログインを止めない。** 招待が無いのが普通の状態。
  const becameStaff = await claimStaffInvitation(result.data.accessToken);

  // ⚠️ 戻り先は `request.url` から組み立てる。`nextUrl` だとホストが
  //    変わることがあり、いま書いた Cookie が届かない（`siteRedirect`）。
  //
  // 招待を受け取った人は、出品欄ではなく運営の画面へ送る。
  // 招待状のつもりで開いた人に、心当たりのない画面を見せないため。
  const response = siteRedirect(becameStaff ? '/admin/artworks' : next, { status: 303 });
  return writeSessionToResponse(response, result.data, isSecureRequest(request));
}

function redirectToLogin(next: string): NextResponse {
  return siteRedirect('/login', { params: { next, expired: '1' }, status: 303 });
}
