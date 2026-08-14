import { randomBytes } from 'node:crypto';
import type { ClockPort, DeliveryAttemptOutcome, WalletDeliverySenderPort } from '@sengoku/domain';
import { HMAC_HEADERS, signRequest } from './sennokuni-hmac';

/**
 * OVEW Wallet への配送（Market → Wallet）。
 *
 * 契約: 千ノ国共通 HMAC v1.1 FINAL（PR-NW04 §15）。
 * 受信側（Claim API）で使っている `signRequest` と**同じ関数**を使う。
 * 送信側だけ別実装にすると、片方を直したときにもう片方が置き去りになる。
 *
 * ⚠️ **本文を組み立て直さない。**
 * 渡された文字列に署名し、その文字列をそのまま送る。
 * parse して stringify すると、キー順や空白が変わって
 * 署名対象と送信内容がずれる。相手からは 401 に見え、原因は本文に残らない。
 */

export interface WalletDeliverySenderOptions {
  /** 送信先の完全な URL。 */
  readonly endpoint: string;
  readonly keyId: string;
  /** ⚠️ ログへ出さない。例外メッセージにも入れない。 */
  readonly secret: string;
  readonly clock: ClockPort;
  /** 応答を待つ上限。待ち続けると配送ワーカーが詰まる。 */
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  /** テストで固定するための差し替え口。既定は CSPRNG。 */
  readonly nonceFactory?: () => string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const NONCE_BYTES = 16;

/** ヘッダ名。相手と綴りを合わせる（§15）。 */
export const WALLET_DELIVERY_HEADERS = {
  idempotencyKey: 'idempotency-key',
  correlationId: 'x-correlation-id',
  eventVersion: 'x-event-version',
} as const;

export class HttpWalletDeliverySender implements WalletDeliverySenderPort {
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly nonceFactory: () => string;

  constructor(private readonly options: WalletDeliverySenderOptions) {
    if (options.secret.length === 0) {
      throw new Error('wallet delivery secret must not be empty');
    }
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.nonceFactory =
      options.nonceFactory ?? ((): string => randomBytes(NONCE_BYTES).toString('hex'));
  }

  async send(input: {
    readonly eventId: string;
    readonly correlationId: string;
    readonly payload: string;
  }): Promise<DeliveryAttemptOutcome> {
    const url = new URL(this.options.endpoint);
    const timestamp = String(Math.floor(this.options.clock.now().getTime() / 1000));
    const nonce = this.nonceFactory();

    const signature = signRequest(this.options.secret, {
      keyId: this.options.keyId,
      timestamp,
      nonce,
      method: 'POST',
      // ⚠️ クエリ文字列を含めない（正準文字列の定義）。
      path: url.pathname,
      rawBody: input.payload,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      const response = await this.fetchImpl(url.toString(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [HMAC_HEADERS.keyId]: this.options.keyId,
          [HMAC_HEADERS.timestamp]: timestamp,
          [HMAC_HEADERS.nonce]: nonce,
          [HMAC_HEADERS.signature]: signature,
          // ⚠️ 相手の冪等キーはイベントIDそのもの。再試行でも変えない（§16）。
          [WALLET_DELIVERY_HEADERS.idempotencyKey]: input.eventId,
          [WALLET_DELIVERY_HEADERS.correlationId]: input.correlationId,
          // ⚠️ 本文の `event_version` から取る。**別の定数から埋めない。**
          //    2 か所から埋めると、片方だけ上げたときに食い違う（§14）。
          [WALLET_DELIVERY_HEADERS.eventVersion]: eventVersionOf(input.payload),
        },
        body: input.payload,
        signal: controller.signal,
      });
      return { kind: 'response', statusCode: response.status };
    } catch (error) {
      // ⚠️ 例外の中身をそのまま返さない。URL や本文が混ざりうる。
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
 * ヘッダへ載せる版数を、**本文から**取り出す。
 *
 * ⚠️ 定数から埋めない。ヘッダと本文が食い違うと、相手はヘッダで分岐して
 * 本文を読み違える。同じ 1 か所から両方を作れば、食い違いは起こしようがない。
 */
function eventVersionOf(payload: string): string {
  const parsed: unknown = JSON.parse(payload);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('event_version' in parsed) ||
    typeof (parsed as { event_version: unknown }).event_version !== 'string'
  ) {
    throw new Error('payload has no event_version');
  }
  return (parsed as { event_version: string }).event_version;
}
