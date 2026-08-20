import { RETRY_MAX_ATTEMPTS, retryBackoffMs } from '../retry/backoff';

/**
 * Wallet への配送を 1 回試したあと、その行をどう扱うかの判定。
 *
 * ⚠️ **「送れた」と「届いた」を混同しない。**
 * 2xx を成功とみなしてよいのは、それが Holding の永続化
 * （または同一イベントの冪等成功）を意味する場合だけ（PR-NW04 §21）。
 * 相手が「共通顧客IDが合わないので何もしなかった」ときに 2xx を返す仕様なら、
 * こちらの `delivered` は嘘になる。接続前に相手の契約を確認する。
 *
 * この判定は時計を持たない。現在時刻は呼び出し元が渡す。
 */

/** 配送行の状態。DB の enum と同じ。 */
export const WALLET_DELIVERY_OUTBOX_STATUSES = [
  'PENDING',
  'PROCESSING',
  'DELIVERED',
  'FAILED',
  'DEAD',
  /**
   * 取消に追い越されたため、もう送らない付与イベント。
   *
   * ⚠️ **終端。ここから戻る道は無い。** 全額返金で取り消した受取権について、
   * まだ送っていない `entitlement.granted` を残したまま自動配送させると、
   * 取り消したはずの作品が**あとから相手側に現れる**。
   *
   * ⚠️ **行は消さない。** 「送ろうとしていた」という事実は残す。
   */
  'SUPERSEDED',
] as const;
export type WalletDeliveryOutboxStatus = (typeof WALLET_DELIVERY_OUTBOX_STATUSES)[number];

/** 1 回の送信で起きたこと。 */
export type DeliveryAttemptOutcome =
  /** 相手が 2xx を返した。 */
  | { readonly kind: 'response'; readonly statusCode: number }
  /** 時間切れ。**送信済みかどうかは分からない。** */
  | { readonly kind: 'timeout' }
  /** 接続できなかった・切れた。 */
  | { readonly kind: 'network' };

/** この行を次にどう扱うか。 */
export type DeliveryDecision =
  | { readonly next: 'DELIVERED' }
  /** 時間をおいて再試行する。 */
  | {
      readonly next: 'PENDING';
      readonly retryAfterMs: number;
      readonly errorCode: string;
    }
  /** 同じ内容を送り直しても直らない。自動再試行を止める。 */
  | { readonly next: 'FAILED'; readonly errorCode: string }
  /** 再試行の上限を超えた。人手に回す。 */
  | { readonly next: 'DEAD'; readonly errorCode: string };

export interface DeliveryAttemptContext {
  /** **この試行を数えたあと**の回数。1 回目の試行直後なら 1。 */
  readonly attemptCount: number;
  readonly maxAttempts: number;
}

/**
 * 時間をおけば直りうる失敗か（§18）。
 *
 * `timeout` / `network` / 5xx / 429 のみ再試行する。
 * それ以外の 4xx は**送っている内容が悪い**ので、同じ内容の再送では直らない。
 * 叩き続けても相手の負荷が増えるだけで、こちらの問題は見えないまま残る。
 */
export function isRetryable(outcome: DeliveryAttemptOutcome): boolean {
  if (outcome.kind !== 'response') {
    return true;
  }
  const { statusCode } = outcome;
  if (statusCode === 429) {
    return true;
  }
  return statusCode >= 500 && statusCode <= 599;
}

/** 失敗の分類コード。⚠️ 応答本文をそのまま入れない（秘匿値が混ざりうる）。 */
export function errorCodeFor(outcome: DeliveryAttemptOutcome): string {
  switch (outcome.kind) {
    case 'timeout':
      return 'timeout';
    case 'network':
      return 'network';
    case 'response':
      return `http_${outcome.statusCode}`;
  }
}

/** 2xx かどうか。3xx はリダイレクト追従をしない前提なので成功にしない。 */
export function isSuccessStatus(statusCode: number): boolean {
  return statusCode >= 200 && statusCode <= 299;
}

/**
 * 配送 1 回ぶんの結果から、次の状態を決める。
 *
 * ⚠️ **上限超過を `FAILED` にしない。**
 * `FAILED`（送る内容が悪い）と `DEAD`（相手が復旧しない）は、
 * 運用でやることが違う。前者は直して再送、後者は相手の状況確認。
 * 同じ状態に丸めると、どちらなのかを毎回人が調べ直すことになる。
 */
export function decideDelivery(
  outcome: DeliveryAttemptOutcome,
  context: DeliveryAttemptContext,
): DeliveryDecision {
  if (outcome.kind === 'response' && isSuccessStatus(outcome.statusCode)) {
    return { next: 'DELIVERED' };
  }

  const errorCode = errorCodeFor(outcome);

  if (!isRetryable(outcome)) {
    return { next: 'FAILED', errorCode };
  }

  if (context.attemptCount >= context.maxAttempts) {
    return { next: 'DEAD', errorCode };
  }

  return {
    next: 'PENDING',
    retryAfterMs: retryBackoffMs(context.attemptCount),
    errorCode,
  };
}

/** 配送の既定の試行上限（§18）。共通バックオフと同じ値を使う。 */
export const WALLET_DELIVERY_MAX_ATTEMPTS = RETRY_MAX_ATTEMPTS;

/**
 * 手動再送してよい状態か（§20）。
 *
 * ⚠️ **`PROCESSING` を再送の対象にしない。**
 * その行は今まさに誰かが送っている最中か、送信直後に落ちた可能性がある。
 * 相手へ届いているかどうかが分からない状態で押し直すと、
 * 相手の冪等性だけが最後の砦になる。
 *
 * ⚠️ **`DELIVERED` も対象にしない。** 届いたものを送り直す理由がない。
 *
 * ⚠️ **`SUPERSEDED` も対象にしない。** 取消に追い越された付与を送り直すと、
 * 取り消したはずの作品が相手側に現れる。**再送してよい状態を列挙**にして
 * あるので、状態を足しても既定で再送対象にはならない。
 */
export function canManuallyResend(status: WalletDeliveryOutboxStatus): boolean {
  return status === 'FAILED' || status === 'DEAD';
}
