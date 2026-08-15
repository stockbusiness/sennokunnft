/**
 * グループ内テストのための合言葉の門（`UD-101` が決まるまでの暫定）。
 *
 * 正式名・運営主体が決まるまでのあいだ、サイトを関係者だけに見せるための
 * 一時的な仕組み。
 *
 * ⚠️ **これは認証ではない。**
 * 誰が見たかは分からず、合言葉を教わった人が転送するのも止められない。
 * 「URL を偶然知った人・検索から来た人を止める」までが役割で、
 * それ以上のことを期待しない。利用者ごとの認可（`UD-801`）は別の話。
 *
 * ⚠️ **api（`sennokunnft-api.fly.dev`）はこの門の外側にある。**
 * 直接叩けば作品名と価格は読める。「サイト全体が隠れた」と思わないこと。
 */

/** 合言葉を通ったことを覚えておく入れ物。 */
export const GATE_COOKIE = 'sengoku_gate';

/** 覚えておく期間。長すぎると、合言葉を変えるまで抜けられない人が残る。 */
export const GATE_COOKIE_MAX_AGE_SEC = 30 * 24 * 60 * 60;

/**
 * 署名の対象。固定文字列でよい。
 *
 * 秘密は鍵（合言葉）側にあり、対象を秘密にする必要はない。
 * 版番号を含めてあるので、仕組みを変えるときは末尾を上げれば
 * 古い入れ物がまとめて無効になる。
 */
const GATE_MESSAGE = 'sengoku-site-gate-v1';

/**
 * 入れ物に入れる値を作る。
 *
 * ⚠️ **合言葉そのものを入れ物へ書かない。**
 * 入れ物はブラウザに残り、開発者ツールから読める。合言葉が見えると、
 * 画面を借りただけの人にも伝わってしまう。
 *
 * ✅ **合言葉を変えると、既に配った入れ物がすべて無効になる。**
 * 鍵が変われば署名が変わるため。呼び戻しの手順を別に用意しなくてよい。
 */
export async function gateToken(password: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(GATE_MESSAGE));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 長さと中身を、途中で打ち切らずに比べる。
 *
 * ⚠️ **`===` を使わない。** 先頭から順に比べて違えばすぐ返す実装だと、
 * 応答までの時間から「どこまで合っていたか」が分かる。
 * ここで比べるのは署名なので実害は小さいが、**比べ方の作法を
 * 場所ごとに変えない**。
 */
export function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * 門を通さない場所。
 *
 * ⚠️ **合言葉を入れる画面そのものを門の内側に置かない。**
 * 置くと、入る前に入れないという堂々巡りになる。
 *
 * ⚠️ **`/api/health` を通すのは、監視が合言葉を持てないため。**
 * 中身は「動いているか」だけで、作品の情報を含まない。
 */
const EXEMPT_PREFIXES = ['/enter', '/api/enter', '/api/health', '/_next/', '/favicon.ico'] as const;

export function isExemptPath(pathname: string): boolean {
  return EXEMPT_PREFIXES.some(
    (prefix) =>
      pathname === prefix || pathname.startsWith(`${prefix}/`) || pathname.startsWith(prefix),
  );
}

/**
 * 合言葉を入れたあとの戻り先。
 *
 * ⚠️ **外部のURLへ飛ばさない。** 受け取った値をそのまま戻り先にすると、
 * 「合言葉の画面から知らない場所へ送られる」経路ができる。
 * `//` や `/\` は、ブラウザによっては別のサイトとして解釈される。
 */
export function safeNextPath(value: string | null | undefined): string {
  if (typeof value !== 'string' || !value.startsWith('/')) {
    return '/';
  }
  if (value.startsWith('//') || value.startsWith('/\\')) {
    return '/';
  }
  return value;
}

/**
 * 門を働かせるべき環境かどうか。
 *
 * ⚠️ **合言葉が未設定なら、公開環境ではすべて拒否する。**
 * 素通しにすると、設定を忘れたことに誰も気づけないまま公開が続く。
 * 手元（`development`）だけは、合言葉が無くても素通しでよい。
 */
export type GateDecision =
  { readonly kind: 'open' } | { readonly kind: 'ask' } | { readonly kind: 'misconfigured' };

export function decideGate(input: {
  readonly password: string | undefined;
  readonly vercelEnv: 'production' | 'preview' | 'development' | undefined;
  readonly hasValidCookie: boolean;
}): GateDecision {
  const deployed = input.vercelEnv === 'production' || input.vercelEnv === 'preview';
  if (input.password === undefined || input.password === '') {
    return deployed ? { kind: 'misconfigured' } : { kind: 'open' };
  }
  return input.hasValidCookie ? { kind: 'open' } : { kind: 'ask' };
}
