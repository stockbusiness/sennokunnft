import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NonceStorePort } from '@sengoku/domain';

/**
 * 千ノ国共通 HMAC 署名 v1.1 FINAL。
 *
 * 確定回答書（2026-08-14）Q4 で、次の 2 方向へ採用が決まった方式。
 *  - OVEW Wallet → 本システム（Claim API）
 *  - 本システム → OVEW Wallet（`entitlement.granted` 等）
 *
 * ⚠️ 代理店システム → 本システムの Webhook は**旧 3 要素形式のまま**であり、
 * 今回は実装しない。混同すると検証が通らない。
 */

/** 正準文字列の構成要素。**順序と区切りが仕様の本体。** */
export interface CanonicalInput {
  readonly keyId: string;
  /** UNIX 秒（文字列）。数値へ変換して比較しない（前ゼロ等で表現が変わるため）。 */
  readonly timestamp: string;
  readonly nonce: string;
  /** 大文字。`POST` / `GET` など。 */
  readonly method: string;
  /** ⚠️ **クエリ文字列を含めない。** */
  readonly path: string;
  /** ⚠️ **受信した生の文字列。** GET など本文が無いときは空文字。 */
  readonly rawBody: string;
}

/**
 * 正準文字列を組み立てる。
 *
 * ```
 * key_id \n timestamp \n nonce \n METHOD \n path \n raw_body
 * ```
 *
 * ⚠️ **JSON を parse して stringify した文字列で署名しない。**
 * キーの順序や空白が変わり、送信側と受信側で別の文字列になる。
 * 署名は「送られてきたバイト列そのもの」に対して行う。
 */
export function canonicalString(input: CanonicalInput): string {
  return [
    input.keyId,
    input.timestamp,
    input.nonce,
    input.method.toUpperCase(),
    input.path,
    input.rawBody,
  ].join('\n');
}

/** 署名を計算する。ヘッダへ載せる形（`sha256=<hex>`）で返す。 */
export function signRequest(secret: string, input: CanonicalInput): string {
  const digest = createHmac('sha256', secret).update(canonicalString(input), 'utf8').digest('hex');
  return `sha256=${digest}`;
}

/** ヘッダ名。両システムで同じ綴りを使う。 */
export const HMAC_HEADERS = {
  keyId: 'x-sennokuni-key-id',
  timestamp: 'x-sennokuni-timestamp',
  nonce: 'x-sennokuni-nonce',
  signature: 'x-sennokuni-signature',
} as const;

/**
 * タイムスタンプの許容幅。
 *
 * 狭すぎると時刻のずれた正規の相手を弾き、広すぎると
 * 録画した要求を再送できる時間が延びる。
 */
export const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

/** 検証の失敗理由。**利用者へそのまま返さない**（どこまで合っていたかを教えてしまう）。 */
export type HmacFailure =
  | 'missing_headers'
  | 'unknown_key'
  | 'malformed_timestamp'
  | 'timestamp_out_of_range'
  | 'signature_mismatch'
  | 'nonce_replayed';

export type HmacVerification =
  | { readonly ok: true; readonly keyId: string }
  | { readonly ok: false; readonly failure: HmacFailure };

export interface VerifyRequestInput {
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly method: string;
  readonly path: string;
  readonly rawBody: string;
  readonly now: Date;
}

export interface HmacVerifierOptions {
  /** 鍵IDから秘密鍵を引く。**ローテーション中は新旧どちらも引けるようにする。** */
  readonly secrets: Readonly<Record<string, string>>;
  readonly nonces: NonceStorePort;
  readonly toleranceMs?: number;
}

/**
 * 受信した要求の署名を検証する。
 *
 * ⚠️ **検証の順序に意味がある。**
 * nonce の記録を最後に行うのは、署名が正しいと分かる前に
 * 記録してしまうと、攻撃者が任意の nonce を使い潰せるため。
 * 正規の相手が同じ nonce を使おうとしたときに弾かれてしまう。
 */
export class SenNoKuniHmacVerifier {
  private readonly toleranceMs: number;

  constructor(private readonly options: HmacVerifierOptions) {
    this.toleranceMs = options.toleranceMs ?? TIMESTAMP_TOLERANCE_MS;
  }

  async verify(input: VerifyRequestInput): Promise<HmacVerification> {
    const keyId = input.headers[HMAC_HEADERS.keyId];
    const timestamp = input.headers[HMAC_HEADERS.timestamp];
    const nonce = input.headers[HMAC_HEADERS.nonce];
    const signature = input.headers[HMAC_HEADERS.signature];

    if (
      keyId === undefined ||
      timestamp === undefined ||
      nonce === undefined ||
      signature === undefined ||
      keyId === '' ||
      timestamp === '' ||
      nonce === '' ||
      signature === ''
    ) {
      return { ok: false, failure: 'missing_headers' };
    }

    const secret = this.options.secrets[keyId];
    if (secret === undefined) {
      return { ok: false, failure: 'unknown_key' };
    }

    // 数字以外が混ざった値を Number() に通すと NaN や部分解釈になる。
    if (!/^\d{1,15}$/.test(timestamp)) {
      return { ok: false, failure: 'malformed_timestamp' };
    }
    const skewMs = Math.abs(input.now.getTime() - Number(timestamp) * 1000);
    if (skewMs > this.toleranceMs) {
      // 未来方向のずれも弾く。時計を進めた要求を貯めておけないようにするため。
      return { ok: false, failure: 'timestamp_out_of_range' };
    }

    const expected = signRequest(secret, {
      keyId,
      timestamp,
      nonce,
      method: input.method,
      path: input.path,
      rawBody: input.rawBody,
    });

    if (!constantTimeEquals(expected, signature)) {
      return { ok: false, failure: 'signature_mismatch' };
    }

    // ⚠️ 署名が正しいと分かってから記録する（上のコメント参照）。
    const fresh = await this.options.nonces.remember({
      keyId,
      nonce,
      // 許容幅を過ぎた要求はどのみち弾かれるので、そこまで覚えていれば足りる。
      expiresAt: new Date(input.now.getTime() + this.toleranceMs),
      now: input.now,
    });
    if (!fresh) {
      return { ok: false, failure: 'nonce_replayed' };
    }

    return { ok: true, keyId };
  }
}

/**
 * 長さを先に比べてから内容を比べる。
 *
 * ⚠️ `===` で比べない。文字列比較は先頭から順に見て違いが出た時点で
 * 返るため、応答時間から「どこまで合っていたか」を推測されうる。
 */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * nonce をメモリに覚える実装。
 *
 * ⚠️ **テストとローカル開発専用。**
 * 台数を増やすと別プロセスの記録が見えず、リプレイを素通しする。
 * 本番では DB 実装（`PrismaNonceStore`）を使う。
 */
export class InMemoryNonceStore implements NonceStorePort {
  private readonly seen = new Map<string, Date>();

  remember(input: { keyId: string; nonce: string; expiresAt: Date; now: Date }): Promise<boolean> {
    const key = `${input.keyId} ${input.nonce}`;
    const existing = this.seen.get(key);
    if (existing !== undefined && existing.getTime() > input.now.getTime()) {
      return Promise.resolve(false);
    }
    this.seen.set(key, input.expiresAt);
    return Promise.resolve(true);
  }
}
