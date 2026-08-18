import { NextResponse, type NextRequest } from 'next/server';
import { decideGate, gateToken, GATE_COOKIE, isExemptPath, safeEqual } from './src/gate';
import { readGatePassword, readVercelEnv } from './src/gate-env';
import { isSecureRequest, middlewareRedirect } from './src/redirect';
import { loginEnabled, readSupabaseAnonKey, readSupabaseUrl } from './src/auth/auth-env';
import { SupabaseAuthGateway } from './src/auth/gateway';
import { writeSessionToResponse } from './src/auth/cookies';
import {
  ACCESS_COOKIE,
  EXPIRES_COOKIE,
  REFRESH_COOKIE,
  isExpired,
  needsRefresh,
  requiresLogin,
} from './src/auth/session';

/**
 * グループ内テストのための合言葉の門（`UD-101` が決まるまでの暫定）。
 *
 * ⚠️ **画面ごとに書かない。** 入口を 1 本にまとめる。
 * ページごとに判定を書くと、あとから足した画面で必ず書き忘れる。
 * 書き忘れは落ちも警告も出さず、**その画面だけ素通し**になる。
 *
 * ⚠️ **合言葉が未設定のまま公開環境へ出たら、すべて拒否する。**
 * 素通しにすると、設定を忘れたことに誰も気づけないまま公開が続く。
 */
export function middleware(request: NextRequest): Promise<NextResponse> | NextResponse {
  const { pathname, search } = request.nextUrl;

  if (isExemptPath(pathname)) {
    return NextResponse.next();
  }

  return decide({
    request,
    pathname,
    search,
    password: readGatePassword(),
    vercelEnv: readVercelEnv(),
  });
}

async function decide(input: {
  readonly request: NextRequest;
  readonly pathname: string;
  readonly search: string;
  readonly password: string | undefined;
  readonly vercelEnv: 'production' | 'preview' | 'development' | undefined;
}): Promise<NextResponse> {
  const cookie = input.request.cookies.get(GATE_COOKIE)?.value ?? '';
  const hasValidCookie =
    input.password !== undefined &&
    input.password !== '' &&
    cookie !== '' &&
    safeEqual(cookie, await gateToken(input.password));

  const decision = decideGate({
    password: input.password,
    vercelEnv: input.vercelEnv,
    hasValidCookie,
  });

  if (decision.kind === 'open') {
    // 門を通ったあとに、誰が操作しているかを見る。
    return withSession(input.request, input.pathname, input.search);
  }

  if (decision.kind === 'misconfigured') {
    // ⚠️ 何が足りないかを画面に書かない。設定の不備を外へ教えない。
    return new NextResponse('この場所は現在ご利用いただけません。', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'x-robots-tag': 'noindex' },
    });
  }

  return middlewareRedirect(input.request, '/enter', {
    next: `${input.pathname}${input.search}`,
  });
}

/**
 * 静的ファイルまで通すと、画像や CSS まで毎回判定することになる。
 * ⚠️ ただし**ページは 1 つも除外しない**。除外はここと `isExemptPath` の
 * 2 か所にあるので、緩めるときは両方を見ること。
 */
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};

/**
 * ログイン状態の面倒を見る。
 *
 * ⚠️ **取り直しはここでしかできない。** Cookie の書き込みは
 * Server Component から行えない。画面側でやろうとすると、
 * 「読めるが更新できない」状態になり、期限が来たら詰む。
 *
 * ⚠️ **ログインを求める場所を画面ごとに書かない。** 入口を 1 本にする。
 * 画面ごとに書くと、あとから足した画面で必ず書き忘れる。
 * 書き忘れは落ちも警告も出さず、**その画面だけ素通し**になる。
 */
async function withSession(
  request: NextRequest,
  pathname: string,
  search: string,
): Promise<NextResponse> {
  const protectedPath = requiresLogin(pathname);

  // ログイン機能を有効にしていない環境（手元・いまの staging）では、
  // 従来どおり運営の資格情報で動く。ここで止めない。
  if (!loginEnabled()) {
    return NextResponse.next();
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const access = request.cookies.get(ACCESS_COOKIE)?.value ?? '';
  const refresh = request.cookies.get(REFRESH_COOKIE)?.value ?? '';
  const expiresAt = Number.parseInt(request.cookies.get(EXPIRES_COOKIE)?.value ?? '', 10);
  const hasExpiry = Number.isSafeInteger(expiresAt);

  const loggedIn = access !== '' && (!hasExpiry || !isExpired(expiresAt, nowSec));

  // 期限が近い（または切れた）が、取り直す手立てがあるなら取り直す。
  if (refresh !== '' && (!hasExpiry || needsRefresh(expiresAt, nowSec))) {
    const url = readSupabaseUrl();
    const anonKey = readSupabaseAnonKey();
    if (url !== undefined && anonKey !== undefined) {
      const result = await new SupabaseAuthGateway({ url, anonKey }).refresh(refresh);
      if (result.ok) {
        return writeSessionToResponse(NextResponse.next(), result.data, isSecureRequest(request));
      }
      // ⚠️ 取り直せなかったときに、ここで Cookie を消さない。
      //    相手側の一時的な不調でも消えてしまい、全員が締め出される。
      //    期限切れの判定は下に任せる。
    }
  }

  if (protectedPath && !loggedIn) {
    return middlewareRedirect(request, '/login', { next: `${pathname}${search}` });
  }

  return NextResponse.next();
}
