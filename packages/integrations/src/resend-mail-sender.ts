import type { MailAttemptOutcome, MailSenderPort } from '@sengoku/domain';

/**
 * メールの送信（Resend の HTTP API）。
 *
 * ⚠️ **依存パッケージを足していない。** 公式 SDK は薄い `fetch` の包みで、
 * こちらが使うのは 1 エンドポイントだけ。持ち込むと、更新のたびに
 * 本筋と関係のない差分を追うことになる。
 *
 * ⚠️ **宛先をログへ出さない。例外メッセージにも入れない。**
 * 失敗したときほど出したくなるが、そこが平文アドレスの最大の漏れ口になる。
 *
 * ⚠️ **本文を組み立て直さない。** 渡された件名と本文をそのまま送る。
 * 送る直前で整形すると、履歴に残した本文と実際に届いた本文がずれる。
 */

export interface ResendMailSenderOptions {
  /** ⚠️ ログへ出さない。 */
  readonly apiKey: string;
  /** 差出人。`名前 <address>` の形も使える。 */
  readonly from: string;
  /** 返信先。⚠️ 未設定なら差出人へ返る。 */
  readonly replyTo?: string | undefined;
  readonly timeoutMs?: number;
  readonly endpoint?: string;
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_ENDPOINT = 'https://api.resend.com/emails';
const DEFAULT_TIMEOUT_MS = 10_000;

export class ResendMailSender implements MailSenderPort {
  private readonly timeoutMs: number;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ResendMailSenderOptions) {
    if (options.apiKey.length === 0) {
      throw new Error('resend api key must not be empty');
    }
    if (options.from.length === 0) {
      throw new Error('mail from address must not be empty');
    }
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async send(input: {
    readonly to: string;
    readonly subject: string;
    readonly body: string;
    readonly idempotencyKey: string;
  }): Promise<MailAttemptOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.options.apiKey}`,
          // ⚠️ 再試行で値を変えない。変えると同じ知らせが 2 通届く。
          'idempotency-key': input.idempotencyKey,
        },
        body: JSON.stringify({
          from: this.options.from,
          to: [input.to],
          subject: input.subject,
          /*
            ⚠️ **平文だけを送る。** HTML を送ると、文面を書く運営が
               タグを書けることになり、そのまま受信箱へ出る。
               差し込み値に `<` が混じったときの逃がし方も要る。
               知らせに必要な表現は平文で足りる。
          */
          text: input.body,
          ...(this.options.replyTo === undefined ? {} : { reply_to: this.options.replyTo }),
        }),
        signal: controller.signal,
      });

      if (response.status >= 200 && response.status <= 299) {
        return { kind: 'accepted', providerMessageId: await messageIdOf(response) };
      }
      // ⚠️ 応答本文を返さない。宛先や鍵が混ざりうる。
      return { kind: 'rejected', statusCode: response.status };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return { kind: 'timeout' };
      }
      return { kind: 'network' };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * 送信事業者が採番した識別子。
 *
 * ⚠️ **取れなくても失敗にしない。** 受け付けられたことは応答の符号で
 * 分かっている。識別子は問い合わせのときに便利なだけの値で、
 * これが無いことを理由に送り直すと、同じ知らせが 2 通届く。
 */
async function messageIdOf(response: Response): Promise<string | null> {
  try {
    const parsed: unknown = await response.json();
    if (typeof parsed === 'object' && parsed !== null) {
      const id = (parsed as Record<string, unknown>)['id'];
      if (typeof id === 'string' && id.length > 0) {
        return id;
      }
    }
  } catch {
    // 本文が JSON でない。⚠️ 中身は見ない。
  }
  return null;
}
