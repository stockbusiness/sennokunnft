import { RETRY_MAX_ATTEMPTS, retryBackoffMs } from '../retry/backoff';

/**
 * 知らせを 1 通送ったあと、その行をどう扱うかの判定。
 *
 * ⚠️ **Wallet 配送と同じ語彙にしていない。** あちらの `DELIVERED` は
 * 「相手のシステムが保存した」で、こちらの `SENT` は「送信事業者が
 * 受け付けた」。**受信箱に届いたことまでは保証できない。** 同じ語を使うと、
 * いつか「届いたはず」として扱われる。
 *
 * 判定そのものは Wallet 配送と同じ規則で、共通のバックオフを使う。
 * 相手は違っても、一時障害の性質は同じであるため。
 */

export const NOTIFICATION_STATUSES = [
  'PENDING',
  'PROCESSING',
  /** 送信事業者が受け付けた。⚠️ **開封も到達も意味しない。** */
  'SENT',
  /** 同じ内容を送り直しても直らない。 */
  'FAILED',
  /** 再試行の上限を超えた。人手に回す。 */
  'DEAD',
  /**
   * 送らずに閉じた。
   *
   * ⚠️ **失敗ではない。** 宛先が分からない・その配備では送らないと
   * 決めている、といった「こちらの都合で送らなかった」を、障害と
   * 混ぜない。混ぜると、失敗件数の監視が常時鳴りっぱなしになる。
   */
  'SKIPPED',
] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

/** 1 通の送信で起きたこと。 */
export type MailAttemptOutcome =
  | { readonly kind: 'accepted'; readonly providerMessageId: string | null }
  | { readonly kind: 'rejected'; readonly statusCode: number }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'network' };

export type NotificationDecision =
  | { readonly next: 'SENT'; readonly providerMessageId: string | null }
  | { readonly next: 'PENDING'; readonly retryAfterMs: number; readonly errorCode: string }
  | { readonly next: 'FAILED'; readonly errorCode: string }
  | { readonly next: 'DEAD'; readonly errorCode: string };

export interface NotificationAttemptContext {
  /** **この試行を数えたあと**の回数。1 回目の試行直後なら 1。 */
  readonly attemptCount: number;
  readonly maxAttempts: number;
}

/**
 * 時間をおけば直りうる失敗か。
 *
 * ⚠️ **宛先が悪い（4xx）ものを再試行しない。** 打ち間違いのアドレスへ
 * 5 回送り直しても届かない。送信事業者からは「弾かれ続ける送信元」に見え、
 * まともな宛先への到達率まで下がる。
 */
export function isRetryableMailOutcome(outcome: MailAttemptOutcome): boolean {
  if (outcome.kind === 'accepted') {
    return false;
  }
  if (outcome.kind !== 'rejected') {
    return true;
  }
  return outcome.statusCode === 429 || (outcome.statusCode >= 500 && outcome.statusCode <= 599);
}

/** 失敗の分類コード。⚠️ 応答本文をそのまま入れない（宛先が混ざりうる）。 */
export function mailErrorCodeFor(outcome: MailAttemptOutcome): string {
  switch (outcome.kind) {
    case 'accepted':
      return 'accepted';
    case 'timeout':
      return 'timeout';
    case 'network':
      return 'network';
    case 'rejected':
      return `http_${outcome.statusCode}`;
  }
}

export function decideNotification(
  outcome: MailAttemptOutcome,
  context: NotificationAttemptContext,
): NotificationDecision {
  if (outcome.kind === 'accepted') {
    return { next: 'SENT', providerMessageId: outcome.providerMessageId };
  }

  const errorCode = mailErrorCodeFor(outcome);

  if (!isRetryableMailOutcome(outcome)) {
    return { next: 'FAILED', errorCode };
  }
  if (context.attemptCount >= context.maxAttempts) {
    return { next: 'DEAD', errorCode };
  }
  return { next: 'PENDING', retryAfterMs: retryBackoffMs(context.attemptCount), errorCode };
}

/** 既定の試行上限。共通バックオフと同じ値を使う。 */
export const NOTIFICATION_MAX_ATTEMPTS = RETRY_MAX_ATTEMPTS;

/** 1 巡で送る通数の上限。⚠️ 復旧直後に全件を叩きつけない。 */
export const NOTIFICATION_BATCH_SIZE = 20;

/**
 * 手動で送り直してよい状態か。
 *
 * ⚠️ **`PROCESSING` を対象にしない。** 送信事業者が受け付けたかどうかが
 * 分からない状態で押し直すと、同じ知らせが 2 通届く。
 *
 * ⚠️ **`SENT` も対象にしない。** 送信事業者は受け付けている。
 *
 * ⚠️ **`SKIPPED` も対象にしない。** 送らないと決めたものを、
 * 一覧の見た目が揃うからという理由で送れるようにしない。
 */
export function canResendNotification(status: NotificationStatus): boolean {
  return status === 'FAILED' || status === 'DEAD';
}
