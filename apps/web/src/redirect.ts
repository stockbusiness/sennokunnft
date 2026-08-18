import { NextResponse, type NextRequest } from 'next/server';

/**
 * サイト内の別の場所へ送る（**経路ハンドラ用**）。
 *
 * ⚠️ **絶対URLで返さない。** 経路ハンドラでは `request.nextUrl` も
 * `request.url` も、ホストが利用者の使ったものと**一致しないことがある**。
 * 実際に `127.0.0.1` で開いた要求が `localhost` へ飛ばされた。
 *
 * ホストが変わると **Cookie が届かない**。ホストごとに別物として扱われる。
 * ログインの Cookie を書いた直後に「ログインしていない」と判定され、
 * ログイン画面へ戻される。**書けているのに入れない**という、
 * 原因の見えない不具合になる。
 *
 * 相対パスなら、ブラウザがいまいる場所を基準に解決するので、
 * こちらがホストを知る必要がない。
 *
 * ⚠️ **middleware では使えない。** あちらは Location を絶対URLとして
 * 解釈するため、相対パスを渡すと `Invalid URL` で 500 になる。
 * middleware では `middlewareRedirect` を使う。あちらの `nextUrl` は
 * 利用者のホストを保つので、絶対URLで問題ない（経路ハンドラと違う）。
 */
export function siteRedirect(
  pathname: string,
  options: { readonly params?: Record<string, string>; readonly status?: 302 | 303 } = {},
): NextResponse {
  // 組み立てのためだけに使う土台。ホストは捨てるので何でもよい。
  const builder = new URL(pathname, 'http://placeholder.invalid');
  builder.search = '';
  for (const [key, value] of Object.entries(options.params ?? {})) {
    builder.searchParams.set(key, value);
  }
  const location = `${builder.pathname}${builder.search}`;

  return new NextResponse(null, {
    status: options.status ?? 302,
    headers: { location },
  });
}

/**
 * その要求が https で来たか（Cookie に `secure` を付けるかの判断）。
 *
 * ⚠️ **`x-forwarded-proto` を先に見る。** Vercel や Fly の内側では、
 * 実際の接続は http になる。それだけを見ると、本番でも `secure` が
 * 付かなくなる。
 */
export function isSecureRequest(request: NextRequest): boolean {
  const forwarded = request.headers.get('x-forwarded-proto');
  if (forwarded !== null && forwarded !== '') {
    return forwarded.split(',')[0]?.trim() === 'https';
  }
  return new URL(request.url).protocol === 'https:';
}

/**
 * middleware から送る（**絶対URLが要る**）。
 *
 * ⚠️ **経路ハンドラの `siteRedirect` と作りが違う。**
 * middleware は Location を絶対URLとして解釈するため、相対パスでは
 * `Invalid URL` になる。一方 middleware の `nextUrl` は利用者の
 * ホストを保つので、そこから組み立ててよい。
 * この非対称は Next 側の都合で、こちらの好みではない。
 */
export function middlewareRedirect(
  request: NextRequest,
  pathname: string,
  params: Record<string, string> = {},
): NextResponse {
  const target = request.nextUrl.clone();
  target.pathname = pathname;
  target.search = '';
  for (const [key, value] of Object.entries(params)) {
    target.searchParams.set(key, value);
  }
  return NextResponse.redirect(target);
}
