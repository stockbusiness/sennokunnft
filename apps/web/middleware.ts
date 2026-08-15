import { NextResponse, type NextRequest } from 'next/server';
import { decideGate, gateToken, GATE_COOKIE, isExemptPath, safeEqual } from './src/gate';
import { readGatePassword, readVercelEnv } from './src/gate-env';

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
    return NextResponse.next();
  }

  if (decision.kind === 'misconfigured') {
    // ⚠️ 何が足りないかを画面に書かない。設定の不備を外へ教えない。
    return new NextResponse('この場所は現在ご利用いただけません。', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'x-robots-tag': 'noindex' },
    });
  }

  const target = input.request.nextUrl.clone();
  target.pathname = '/enter';
  target.search = '';
  target.searchParams.set('next', `${input.pathname}${input.search}`);
  return NextResponse.redirect(target);
}

/**
 * 静的ファイルまで通すと、画像や CSS まで毎回判定することになる。
 * ⚠️ ただし**ページは 1 つも除外しない**。除外はここと `isExemptPath` の
 * 2 か所にあるので、緩めるときは両方を見ること。
 */
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
