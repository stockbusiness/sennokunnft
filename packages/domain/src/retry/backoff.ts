/**
 * 外部システムへの再試行の共通バックオフ。
 *
 * 千ノ国の連携（共通顧客IDの解決・Wallet への配送）はどれも
 * **同じ相手・同じ性質の障害**を相手にする。間隔がばらばらだと、
 * 片方が復旧を待っているあいだにもう片方が叩き続ける。
 *
 * 前半を細かく、後半を粗くしているのは、一時障害はたいてい数分で回復し、
 * それを超える障害は人手対応が要るため。
 */
export const RETRY_BACKOFF_MINUTES: readonly number[] = [1, 5, 15, 60, 240];

/** 再試行の上限。超えたら自動再試行をやめ、人手に回す。 */
export const RETRY_MAX_ATTEMPTS = 5;

/**
 * 次回試行までの待ち時間（分）。
 *
 * @param attemptCount これまでに実行した試行回数（1 回失敗した直後なら 1）
 */
export function retryBackoffMinutes(attemptCount: number): number {
  const index = Math.min(Math.max(attemptCount - 1, 0), RETRY_BACKOFF_MINUTES.length - 1);
  return RETRY_BACKOFF_MINUTES[index] ?? RETRY_BACKOFF_MINUTES[RETRY_BACKOFF_MINUTES.length - 1]!;
}

/** 次回試行までの待ち時間（ミリ秒）。 */
export function retryBackoffMs(attemptCount: number): number {
  return retryBackoffMinutes(attemptCount) * 60_000;
}
