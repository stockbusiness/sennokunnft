'use server';

import { headers } from 'next/headers';
import { SupabaseAuthGateway } from '../../src/auth/gateway';
import { normalizeEmail, safeReturnPath } from '../../src/auth/session';
import { LOGIN_COPY } from '../../src/auth/copy';
import { getWebEnv } from '../../src/env';

export interface LoginState {
  readonly error?: string;
  readonly sent?: boolean;
}

/**
 * ログイン用のリンクを送る。
 *
 * ⚠️ **戻り先を要求の Host から組み立てない。** 偽の Host を送られると、
 * ログインのリンクを攻撃者の場所へ向けさせられる。設定値を使う。
 */
export async function sendLinkAction(_previous: LoginState, form: FormData): Promise<LoginState> {
  const env = getWebEnv();
  if (env.SUPABASE_URL === undefined || env.SUPABASE_ANON_KEY === undefined) {
    return { error: LOGIN_COPY.disabled };
  }

  const email = normalizeEmail(form.get('email'));
  if (email === null) {
    return { error: LOGIN_COPY.invalidEmail };
  }

  const origin = env.WEB_PUBLIC_ORIGIN ?? (await fallbackOrigin());
  const next = safeReturnPath(
    typeof form.get('next') === 'string' ? String(form.get('next')) : null,
  );
  const redirectTo = `${origin}/api/auth/confirm?next=${encodeURIComponent(next)}`;

  const gateway = new SupabaseAuthGateway({
    url: env.SUPABASE_URL,
    anonKey: env.SUPABASE_ANON_KEY,
  });
  const result = await gateway.sendMagicLink(email, redirectTo);
  if (!result.ok) {
    return { error: result.reason === 'rejected' ? LOGIN_COPY.rejected : LOGIN_COPY.unavailable };
  }

  // ⚠️ 送れたかどうかだけを返す。「登録済みでした」等を返さない。
  return { sent: true };
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
