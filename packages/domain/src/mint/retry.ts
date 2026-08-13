import type { MintJobStatus } from '../state/machines';

/**
 * 再試行のバックオフ（分）。
 *
 * 前半を細かく、後半を粗くしている。一時障害はたいてい数分で回復し、
 * それを超える障害は人手対応が要るため、無駄な試行を減らす意図。
 * 数値は運用開始後に調整する（DOMAIN_MODEL.md §4.3）。
 */
export const BACKOFF_MINUTES: readonly number[] = [1, 5, 15, 60, 180];

export const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * 次回実行までの待ち時間（ミリ秒）。
 *
 * @param attemptCount これまでに実行した試行回数（1 回失敗した直後なら 1）
 */
export function backoffMs(attemptCount: number): number {
  if (attemptCount < 1) {
    return BACKOFF_MINUTES[0]! * 60_000;
  }
  const index = Math.min(attemptCount - 1, BACKOFF_MINUTES.length - 1);
  return BACKOFF_MINUTES[index]! * 60_000;
}

export interface MintJobSnapshot {
  readonly status: MintJobStatus;
  readonly attemptCount: number;
  readonly maxAttempts: number;
}

export interface RetryDecision {
  /** 次に遷移すべき状態。 */
  readonly nextStatus: Extract<MintJobStatus, 'queued' | 'failed'>;
  /** `queued` に戻す場合の待ち時間。`failed` の場合は 0。 */
  readonly delayMs: number;
}

/**
 * 発行失敗後の扱いを決める。
 *
 * 試行上限を超えたら自動再試行を止め、`failed` にして運用アラートへ回す。
 * 無限に再試行すると、外部APIへの負荷と「いつまでも解決しない」状態を生む。
 */
export function decideRetry(job: MintJobSnapshot): RetryDecision {
  if (job.attemptCount >= job.maxAttempts) {
    return { nextStatus: 'failed', delayMs: 0 };
  }
  return { nextStatus: 'queued', delayMs: backoffMs(job.attemptCount) };
}

/**
 * 全額返金時に、発行ジョブを取り消してよいかを判定する。
 *
 * `processing` の行は**外部へ送信済みの可能性がある**ため取り消さない（INV-M4）。
 * 取り消してしまうと、実際には発行されたトークンの記録が残らず、
 * 台帳と実態が乖離する。多重発行・記録漏れ（回復不能）よりも、
 * 注記を残して人手で確認する（回復可能）方を選ぶ。
 */
export function canCancelOnRefund(status: MintJobStatus): boolean {
  return status === 'queued' || status === 'failed';
}
