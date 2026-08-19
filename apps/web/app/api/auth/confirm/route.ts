import { NextResponse, type NextRequest } from 'next/server';
import { SupabaseAuthGateway } from '../../../../src/auth/gateway';
import { safeReturnPath } from '../../../../src/auth/session';
import { writeSessionToResponse } from '../../../../src/auth/cookies';
import { claimStaffInvitation } from '../../../../src/auth/invitation';
import { consentRequired } from '../../../../src/legal-consent-client';
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

  /*
    規約への同意（`UD-126`）。

    ⚠️ **ここで見るのは、ログインが「初回も 2 回目も通る唯一の場所」だから。**
       会員登録の画面が別にあるわけではない（登録もログインも同じリンク）。
       改定後の再同意も、次にログインしたときに一度だけ求まる。

    ⚠️ **確かめられないときは求めない。** API が落ちているときに同意画面へ
       送ると、ログインした人がそこから先へ進めない。**確認できないことを
       理由に締め出さない。** 同意の記録が 1 回遅れるほうが軽い。

    ⚠️ **Cookie を書いてから判定しない。** 判定には資格情報が要るので、
       先に Cookie を書いた応答を作り、行き先だけを差し替える。
  */
  const destination = becameStaff ? '/admin/artworks' : next;

  // ⚠️ 戻り先は `request.url` から組み立てる。`nextUrl` だとホストが
  //    変わることがあり、いま書いた Cookie が届かない（`siteRedirect`）。
  //
  // 招待を受け取った人は、出品欄ではなく運営の画面へ送る。
  // 招待状のつもりで開いた人に、心当たりのない画面を見せないため。
  const consentPath = await consentRedirect(result.data.accessToken, destination);
  const response = siteRedirect(consentPath ?? destination, { status: 303 });
  return writeSessionToResponse(response, result.data, isSecureRequest(request));
}

/**
 * 同意が要るなら、その画面への行き先を返す。要らなければ `null`。
 *
 * ⚠️ **失敗したら `null`。** 同意画面で止めない。
 */
async function consentRedirect(accessToken: string, next: string): Promise<string | null> {
  const required = await consentRequired(accessToken);
  return required ? `/legal/consent?next=${encodeURIComponent(next)}` : null;
}

function redirectToLogin(next: string): NextResponse {
  return siteRedirect('/login', { params: { next, expired: '1' }, status: 303 });
}
