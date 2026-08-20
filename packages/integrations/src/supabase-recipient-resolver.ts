import type { RecipientResolution, RecipientResolverPort } from '@sengoku/domain';

/**
 * 宛先を認証基盤（Supabase Auth）から取り出す（`UD-503` 決定 2026-08-20）。
 *
 * ⚠️ **本システムは購入者のメールアドレスを平文で持たない。** 認証の正は
 * Supabase 側にあるので、送信の瞬間だけそこから取り出し、送り終えたら捨てる。
 *
 * ⚠️ **取り出した値をログへ出さない。例外メッセージにも入れない。**
 * 失敗したときほど出したくなるが、そこが最大の漏れ口になる。
 *
 * ⚠️ **`service_role` の鍵を使う。** 全利用者を読める強い鍵なので、
 * **この用途以外へ配らない**。API のプロセス内だけで持ち、画面側へ渡さない。
 */

export interface SupabaseRecipientResolverOptions {
  /** `https://xxxx.supabase.co` の形。 */
  readonly url: string;
  /** ⚠️ ログへ出さない。例外メッセージにも入れない。 */
  readonly serviceRoleKey: string;
  /** 応答を待つ上限。待ち続けると送信の巡回が詰まる。 */
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 5_000;

/** 認証基盤での本人の識別子を引く口。⚠️ 本システム側の accountId とは別。 */
export interface AuthSubjectLookup {
  /** その本人の `auth_subject`。⚠️ 分からなければ `null`。 */
  findAuthSubject(accountId: string): Promise<string | null>;
}

export class SupabaseRecipientResolver implements RecipientResolverPort {
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly options: SupabaseRecipientResolverOptions,
    private readonly subjects: AuthSubjectLookup,
  ) {
    if (options.serviceRoleKey.length === 0) {
      throw new Error('supabase service role key must not be empty');
    }
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async resolve(accountId: string): Promise<RecipientResolution> {
    const subject = await this.subjects.findAuthSubject(accountId);
    if (subject === null) {
      // その本人が認証基盤に居ない。⚠️ 障害ではない。
      return { kind: 'unknown' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      const response = await this.fetchImpl(
        `${this.options.url.replace(/\/+$/, '')}/auth/v1/admin/users/${encodeURIComponent(subject)}`,
        {
          method: 'GET',
          headers: {
            apikey: this.options.serviceRoleKey,
            authorization: `Bearer ${this.options.serviceRoleKey}`,
          },
          signal: controller.signal,
        },
      );

      if (response.status === 404) {
        return { kind: 'unknown' };
      }
      if (!response.ok) {
        // ⚠️ 応答本文を読まない。読むと、いつかログへ出す実装を誘う。
        return { kind: 'unavailable' };
      }

      const parsed: unknown = await response.json();
      const email = emailOf(parsed);
      if (email === null) {
        return { kind: 'unknown' };
      }
      return { kind: 'resolved', email };
    } catch {
      // ⚠️ 例外の中身を見ない・返さない。URL や鍵が混ざりうる。
      return { kind: 'unavailable' };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * 応答から宛先だけを取り出す。
 *
 * ⚠️ **確認の済んでいないアドレスへ送らない。** 登録の途中で放置された
 * アドレスへ送り続けると、送信元の評判が落ち、まともな宛先への到達率まで下がる。
 */
function emailOf(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const email = record['email'];
  if (typeof email !== 'string' || email.length === 0) {
    return null;
  }
  const confirmed = record['email_confirmed_at'];
  if (confirmed === null || confirmed === undefined) {
    return null;
  }
  return email;
}
