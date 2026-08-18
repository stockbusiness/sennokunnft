import type { Session } from './session';

/**
 * Supabase Auth との受け渡し。
 *
 * ⚠️ **境界として切ってある。** ここを直接呼ぶ形にすると、
 * 画面と Cookie の試験のたびに本物のメールが飛ぶ。
 * 擬似実装に差し替えられるようにしておく。
 *
 * ⚠️ **失敗の中身を呼び出し元へ流さない。** 応答本文には
 * 「そのアドレスは登録済み」といった情報が混ざりうる。
 * 存在の有無が分かると、アドレスの当てずっぽうに使える。
 */
export type AuthFailure =
  /** 送信できなかった・確認できなかった（理由は問わない）。 */
  | 'rejected'
  /** こちら側または相手側の不調。時間をおけば直りうる。 */
  | 'unavailable';

export type AuthResult<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly reason: AuthFailure };

export interface AuthGateway {
  /** ログイン用のリンクをメールで送る。未登録なら同時に登録される。 */
  sendMagicLink(email: string, redirectTo: string): Promise<AuthResult<null>>;
  /** メールのリンクに含まれる合図を、ログイン状態に引き換える。 */
  confirm(tokenHash: string, type: string): Promise<AuthResult<Session>>;
  /** 期限が近いログイン状態を取り直す。 */
  refresh(refreshToken: string): Promise<AuthResult<Session>>;
  /** ログアウト（相手側のセッションも終わらせる）。 */
  signOut(accessToken: string): Promise<void>;
}

export interface SupabaseAuthGatewayOptions {
  /** 例: `https://<ref>.supabase.co` */
  readonly url: string;
  /**
   * 公開鍵（anon / publishable key）。
   *
   * ⚠️ **秘密鍵（service_role）を渡さない。** あれは行単位の権限を
   * すべて飛び越える。ログインの送信に必要なのは公開鍵だけ。
   */
  readonly anonKey: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
}

interface TokenResponse {
  readonly access_token?: unknown;
  readonly refresh_token?: unknown;
  readonly expires_in?: unknown;
  readonly expires_at?: unknown;
}

export class SupabaseAuthGateway implements AuthGateway {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: SupabaseAuthGatewayOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async sendMagicLink(email: string, redirectTo: string): Promise<AuthResult<null>> {
    const url = new URL('/auth/v1/otp', this.options.url);
    url.searchParams.set('redirect_to', redirectTo);

    const response = await this.call(url, {
      email,
      // 未登録なら登録も兼ねる。「登録」と「ログイン」を分けない。
      // 分けると、利用者が自分がどちらか覚えていないと進めなくなる。
      create_user: true,
    });
    if (response === null) {
      return { ok: false, reason: 'unavailable' };
    }
    // ⚠️ 未登録・登録済みで応答を変えない。変えると、アドレスの
    //    当てずっぽうで「誰が登録しているか」を調べられる。
    return response.ok ? { ok: true, data: null } : { ok: false, reason: 'rejected' };
  }

  async confirm(tokenHash: string, type: string): Promise<AuthResult<Session>> {
    const url = new URL('/auth/v1/verify', this.options.url);
    const response = await this.call(url, { type, token_hash: tokenHash });
    return this.toSession(response);
  }

  async refresh(refreshToken: string): Promise<AuthResult<Session>> {
    const url = new URL('/auth/v1/token', this.options.url);
    url.searchParams.set('grant_type', 'refresh_token');
    const response = await this.call(url, { refresh_token: refreshToken });
    return this.toSession(response);
  }

  async signOut(accessToken: string): Promise<void> {
    const url = new URL('/auth/v1/logout', this.options.url);
    // ⚠️ 失敗しても呼び出し元を止めない。こちらの Cookie は必ず消す。
    //    相手側が消えなくても、手元に残るほうが害が大きい。
    await this.call(url, {}, accessToken).catch(() => null);
  }

  private async call(
    url: URL,
    body: Record<string, unknown>,
    accessToken?: string,
  ): Promise<Response | null> {
    try {
      return await this.fetchImpl(url.toString(), {
        method: 'POST',
        headers: {
          apikey: this.options.anonKey,
          authorization: `Bearer ${accessToken ?? this.options.anonKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        cache: 'no-store',
      });
    } catch {
      // 通信そのものが失敗した。相手の答えではないので区別する。
      return null;
    }
  }

  private async toSession(response: Response | null): Promise<AuthResult<Session>> {
    if (response === null) {
      return { ok: false, reason: 'unavailable' };
    }
    if (!response.ok) {
      return { ok: false, reason: 'rejected' };
    }

    let payload: TokenResponse;
    try {
      payload = (await response.json()) as TokenResponse;
    } catch {
      return { ok: false, reason: 'unavailable' };
    }

    const accessToken = payload.access_token;
    const refreshToken = payload.refresh_token;
    if (typeof accessToken !== 'string' || typeof refreshToken !== 'string') {
      return { ok: false, reason: 'unavailable' };
    }

    return { ok: true, data: { accessToken, refreshToken, expiresAt: this.expiryOf(payload) } };
  }

  /**
   * 期限を秒で求める。
   *
   * ⚠️ **`expires_at` を優先する。** `expires_in` はこちらの時計との
   * ずれをそのまま持ち込む。相手が絶対時刻を返すなら、そちらを信じる。
   */
  private expiryOf(payload: TokenResponse): number {
    if (typeof payload.expires_at === 'number') {
      return payload.expires_at;
    }
    const seconds = typeof payload.expires_in === 'number' ? payload.expires_in : 3600;
    return Math.floor(this.now().getTime() / 1000) + seconds;
  }
}
