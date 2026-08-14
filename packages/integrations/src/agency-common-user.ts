import type {
  CommonUserDirectoryPort,
  MatchedBy,
  ResolveCommonUserInput,
  ResolveCommonUserResult,
} from '@sengoku/domain';
import { MATCHED_BY_VALUES } from '@sengoku/domain';

/**
 * 代理店システム（共通顧客HUB）のアダプタ。
 *
 * 契約: `team478a/sengoku-agency-system`
 *       `docs/integration/COMMON_HUB_EXTERNAL_CONTRACT_2026-07-21.md`
 *
 * ⚠️ **相手のDBを直接見ない。** API 経由のみ。
 * ⚠️ **`common_user_id` を本システムで作らない。** ここに作る口は無い。
 */

/** 応答のうち本システムが使う部分。知らない項目は無視する（互換のため）。 */
interface ResolveResponseBody {
  readonly ok?: unknown;
  readonly common_user_id?: unknown;
  readonly matched_by?: unknown;
  readonly identity_match_status?: unknown;
}

export interface AgencyCommonUserOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly systemKey: string;
  /** 応答を待つ上限。**待ち続けると呼び出し側の処理が詰まる。** */
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 5_000;

function isMatchedBy(value: unknown): value is MatchedBy {
  return typeof value === 'string' && (MATCHED_BY_VALUES as readonly string[]).includes(value);
}

export class AgencyCommonUserDirectory implements CommonUserDirectoryPort {
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: AgencyCommonUserOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async resolve(input: ResolveCommonUserInput): Promise<ResolveCommonUserResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.options.baseUrl}/api/common-users/resolve`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // 契約 §5。方向ごとに鍵を分ける。
          'x-api-key': this.options.apiKey,
        },
        body: JSON.stringify({
          system_key: this.options.systemKey,
          external_user_id: input.externalUserId,
          // ⚠️ 相手の既定は true。省略しない。
          create_if_missing: input.createIfMissing,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      // 通信できなかった・時間切れ。時間をおけば直りうる。
      return {
        ok: false,
        kind: 'transient',
        // ⚠️ 例外の中身をそのまま入れない。URL や本文が混ざりうる。
        reason: error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'network_error',
      };
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 500) {
      return { ok: false, kind: 'transient', reason: `upstream_${String(response.status)}` };
    }
    if (!response.ok) {
      // 4xx。送っている内容が悪いので、同じ内容で送り直しても直らない。
      return { ok: false, kind: 'permanent', reason: `rejected_${String(response.status)}` };
    }

    let body: ResolveResponseBody;
    try {
      body = (await response.json()) as ResolveResponseBody;
    } catch {
      return { ok: false, kind: 'transient', reason: 'malformed_response' };
    }

    const commonUserId = body.common_user_id;
    const matchedBy = body.matched_by;
    if (typeof commonUserId !== 'string' || !isMatchedBy(matchedBy)) {
      // 契約と違う応答。こちらで補って進めない。
      return { ok: false, kind: 'transient', reason: 'unexpected_response_shape' };
    }

    return {
      ok: true,
      resolution: {
        commonUserId,
        matchedBy,
        identityMatchStatus:
          typeof body.identity_match_status === 'string' ? body.identity_match_status : 'ok',
      },
    };
  }
}

/**
 * ローカル開発・テスト用の擬似実装。
 *
 * ⚠️ **本番で使われないことは、起動時ガードが保証する。**
 * ここで「本番なら実装を差し替える」という条件分岐を書かない。
 * 条件分岐は設定ミスで簡単に裏返る。
 */
export class FakeCommonUserDirectory implements CommonUserDirectoryPort {
  private readonly assigned = new Map<string, string>();
  private queued: ResolveCommonUserResult | null = null;

  /** 次の 1 回だけ指定の結果を返す。失敗経路をテストするために使う。 */
  enqueue(result: ResolveCommonUserResult): void {
    this.queued = result;
  }

  resolve(input: ResolveCommonUserInput): Promise<ResolveCommonUserResult> {
    if (this.queued !== null) {
      const queued = this.queued;
      this.queued = null;
      return Promise.resolve(queued);
    }

    const existing = this.assigned.get(input.externalUserId);
    if (existing !== undefined) {
      return Promise.resolve({
        ok: true,
        resolution: {
          commonUserId: existing,
          matchedBy: 'system_account_link',
          identityMatchStatus: 'ok',
        },
      });
    }

    if (!input.createIfMissing) {
      return Promise.resolve({ ok: false, kind: 'permanent', reason: 'rejected_404' });
    }

    // 決定論的に組み立てる。乱数を使わないのは、同じ入力で同じ結果にするため。
    const digest = fakeHex(input.externalUserId);
    this.assigned.set(input.externalUserId, `cu_${digest}`);
    return Promise.resolve({
      ok: true,
      resolution: {
        commonUserId: `cu_${digest}`,
        matchedBy: 'created',
        identityMatchStatus: 'ok',
      },
    });
  }
}

/** 32 桁 hex を決定論的に作る（擬似実装専用。暗号用途ではない）。 */
function fakeHex(seed: string): string {
  let out = '';
  let value = 0;
  for (let index = 0; index < seed.length; index += 1) {
    value = (value * 31 + seed.charCodeAt(index)) >>> 0;
  }
  for (let index = 0; index < 8; index += 1) {
    value = (value * 1103515245 + 12345) >>> 0;
    out += value.toString(16).padStart(8, '0');
  }
  return out.slice(0, 32);
}
