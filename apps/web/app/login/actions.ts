'use server';

import { sendLoginLink } from '../../src/auth/send-link';
import { normalizeEmail } from '../../src/auth/session';
import { LOGIN_COPY } from '../../src/auth/copy';

export interface LoginState {
  readonly error?: string;
  readonly sent?: boolean;
}

/**
 * ログイン用のリンクを送る。
 *
 * ⚠️ **送信そのものは `sendLoginLink` に寄せてある。** 招待からも
 * 同じ経路を使う。別々に書くと、片方だけ直したときに
 * 「ログインは届くのに招待は届かない」が起きる。
 */
export async function sendLinkAction(_previous: LoginState, form: FormData): Promise<LoginState> {
  const email = normalizeEmail(form.get('email'));
  if (email === null) {
    return { error: LOGIN_COPY.invalidEmail };
  }

  const next = typeof form.get('next') === 'string' ? String(form.get('next')) : undefined;
  const result = await sendLoginLink(email, next);
  if (!result.ok) {
    if (result.reason === 'disabled') {
      return { error: LOGIN_COPY.disabled };
    }
    return { error: result.reason === 'rejected' ? LOGIN_COPY.rejected : LOGIN_COPY.unavailable };
  }

  // ⚠️ 送れたかどうかだけを返す。「登録済みでした」等を返さない。
  return { sent: true };
}
