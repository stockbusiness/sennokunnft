/**
 * ログイン状態の持ち方（`UD-801` 決定済 2026-08-18）。
 *
 * ⚠️ **トークンを localStorage に置かない。** httpOnly Cookie に入れる。
 * JavaScript から読めない形にしておかないと、XSS が 1 つ見つかった時点で
 * 全利用者のトークンが持ち出される。
 *
 * ⚠️ **ここは純粋な計算だけを持つ。** Cookie の読み書きも通信もしない。
 * 期限の判定やパスの検査は、画面・経路・middleware の 3 か所から使う。
 * 通信と混ぜると、その 3 か所で試験できなくなる。
 */

/** 出品や購入に使う短命のトークン。api はこれを検証する。 */
export const ACCESS_COOKIE = 'sengoku_at';
/** 期限が来たときに取り直すための長命のトークン。 */
export const REFRESH_COOKIE = 'sengoku_rt';
/** 期限の目安（秒）。判定を毎回トークンの復号に頼らないために持つ。 */
export const EXPIRES_COOKIE = 'sengoku_exp';

/**
 * 取り直しの猶予（秒）。
 *
 * ⚠️ **0 にしない。** 期限ちょうどで取り直すと、要求が api に届くまでの
 * わずかな時間で切れる。切れた瞬間だけ 401 になり、再読み込みで直る——
 * という再現しにくい不具合になる。
 */
export const REFRESH_MARGIN_SEC = 120;

export interface Session {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** UNIX 秒。 */
  readonly expiresAt: number;
}

/**
 * 認証の入口として素通しにする場所。
 *
 * ⚠️ **ログイン画面そのものを内側に置かない。** 入る前に入れなくなる。
 */
const PUBLIC_PREFIXES = [
  '/login',
  '/api/auth/',
  '/enter',
  '/api/enter',
  '/api/health',
  '/_next/',
  '/favicon.ico',
] as const;

/** ログインを求める場所（いまは出品まわりだけ）。 */
const PROTECTED_PREFIXES = ['/creator'] as const;

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix));
}

export function requiresLogin(pathname: string): boolean {
  if (isPublicPath(pathname)) {
    return false;
  }
  return PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/** 期限切れか（猶予込み）。 */
export function isExpired(expiresAt: number, nowSec: number): boolean {
  return expiresAt <= nowSec;
}

/** そろそろ取り直すべきか。 */
export function needsRefresh(expiresAt: number, nowSec: number): boolean {
  return expiresAt - nowSec <= REFRESH_MARGIN_SEC;
}

/**
 * ログイン後の戻り先。
 *
 * ⚠️ **外部のURLへ飛ばさない。** 受け取った値をそのまま戻り先にすると、
 * 「ログイン画面から知らない場所へ送られる」経路ができる。
 * `//` や `/\` はブラウザによっては別サイトとして解釈される。
 */
export function safeReturnPath(value: string | null | undefined): string {
  if (typeof value !== 'string' || !value.startsWith('/')) {
    return '/creator';
  }
  if (value.startsWith('//') || value.startsWith('/\\')) {
    return '/creator';
  }
  return value;
}

/**
 * 入力されたメールアドレスの下ごしらえ。
 *
 * ⚠️ **形の厳密な検査をここでしない。** 送信先の可否は Supabase が決める。
 * 画面側で独自の正規表現を持つと、通るはずのアドレスを弾いて
 * 「なぜか登録できない人」を生む。ここは前後の空白と大文字小文字だけ整える。
 */
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.length > 320 || !trimmed.includes('@')) {
    return null;
  }
  return trimmed;
}
