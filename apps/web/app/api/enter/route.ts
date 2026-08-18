import { NextResponse, type NextRequest } from 'next/server';
import {
  GATE_COOKIE,
  GATE_COOKIE_MAX_AGE_SEC,
  gateToken,
  safeEqual,
  safeNextPath,
} from '../../../src/gate';
import { readGatePassword } from '../../../src/gate-env';
import { isSecureRequest, siteRedirect } from '../../../src/redirect';

/**
 * 合言葉を受け取る場所（`UD-101` が決まるまでの暫定）。
 *
 * ⚠️ **合言葉そのものを入れ物へ書かない。** 署名だけを入れる。
 * 入れ物はブラウザに残り、開発者ツールから読める。
 */
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const form = await request.formData();
  const submitted = form.get('password');
  const next = safeNextPath(typeof form.get('next') === 'string' ? String(form.get('next')) : null);

  const password = readGatePassword();

  if (password === undefined || typeof submitted !== 'string') {
    return redirectToEnter(next);
  }

  // ⚠️ 合言葉どうしを直接比べず、署名にしてから比べる。
  //    長さの違いが応答時間に出ないようにするため。
  const [expected, actual] = await Promise.all([gateToken(password), gateToken(submitted)]);
  if (!safeEqual(expected, actual)) {
    return redirectToEnter(next);
  }

  // ⚠️ `nextUrl` だとホストが変わることがあり、いま書いた Cookie が届かない。
  const response = siteRedirect(next, { status: 303 });
  response.cookies.set(GATE_COOKIE, expected, {
    httpOnly: true,
    // ⚠️ 手元の http でも試せるように、https のときだけ secure を付ける。
    secure: isSecureRequest(request),
    sameSite: 'lax',
    path: '/',
    maxAge: GATE_COOKIE_MAX_AGE_SEC,
  });
  return response;
}

/**
 * 合言葉の画面へ戻す。
 *
 * ⚠️ **どこが違ったかを伝えない。** 「文字数が違う」「前半は合っている」
 * といった手掛かりを返すと、総当たりの助けになる。
 */
function redirectToEnter(next: string): NextResponse {
  return siteRedirect('/enter', { params: { next, error: '1' }, status: 303 });
}
