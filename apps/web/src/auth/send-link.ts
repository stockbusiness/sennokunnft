import { headers } from 'next/headers';
import { SupabaseAuthGateway, type AuthFailure } from './gateway';
import { safeReturnPath } from './session';
import { getWebEnv } from '../env';

/**
 * ログイン用のリンクをメールで送る。
 *
 * ⚠️ **ログイン画面と招待で、同じ経路を使う。** 別々に書くと、
 * 片方だけ直したときに「ログインは届くのに招待は届かない」が起きる。
 * 実際に、招待側で送信を書き忘れて**一通も届かない**状態になった。
 *
 * ⚠️ **戻り先を要求の Host から組み立てない。** 偽の Host を送られると、
 * ログインのリンクを攻撃者の場所へ向けさせられる。設定値を使う。
 */
export type SendLinkResult =
  | { readonly ok: true }
  /** 送信の設定が入っていない環境（手元など）。 */
  | { readonly ok: false; readonly reason: 'disabled' | AuthFailure };

export async function sendLoginLink(email: string, next?: string): Promise<SendLinkResult> {
  const env = getWebEnv();
  if (env.SUPABASE_URL === undefined || env.SUPABASE_ANON_KEY === undefined) {
    return { ok: false, reason: 'disabled' };
  }

  const origin = env.WEB_PUBLIC_ORIGIN ?? (await fallbackOrigin());
  const target = safeReturnPath(next ?? null);
  const redirectTo = `${origin}/api/auth/confirm?next=${encodeURIComponent(target)}`;

  const gateway = new SupabaseAuthGateway({
    url: env.SUPABASE_URL,
    anonKey: env.SUPABASE_ANON_KEY,
  });
  const result = await gateway.sendMagicLink(email, redirectTo);
  return result.ok ? { ok: true } : { ok: false, reason: result.reason };
}

/**
 * 設定が無いときの逃げ道（手元用）。
 *
 * ⚠️ **本番でここへ落ちないよう `WEB_PUBLIC_ORIGIN` を設定する。**
 * Host は要求側が指定できるので、本来は信用してよい値ではない。
 */
async function fallbackOrigin(): Promise<string> {
  const list = await headers();
  const host = list.get('host') ?? 'localhost:3000';
  const proto = list.get('x-forwarded-proto') ?? 'http';
  return `${proto}://${host}`;
}
