import { describe, expect, it } from 'vitest';
import {
  BACKOFF_MINUTES,
  DEFAULT_MAX_ATTEMPTS,
  backoffMs,
  canCancelOnRefund,
  decideRetry,
  MINT_JOB_STATUSES,
} from '../src/index';

describe('バックオフ（TEST_STRATEGY §3.5 T-4）', () => {
  it('試行回数とともに単調非減少で増える', () => {
    const delays = [1, 2, 3, 4, 5].map((attempt) => backoffMs(attempt));
    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i]!).toBeGreaterThanOrEqual(delays[i - 1]!);
    }
  });

  it('上限を超えても最大値で頭打ちになる', () => {
    const max = BACKOFF_MINUTES[BACKOFF_MINUTES.length - 1]! * 60_000;
    expect(backoffMs(99)).toBe(max);
  });

  it('試行 0 回でも正の待ち時間を返す', () => {
    expect(backoffMs(0)).toBeGreaterThan(0);
  });
});

describe('decideRetry（T-5）', () => {
  it('試行回数が上限未満なら再キューに戻す', () => {
    const decision = decideRetry({
      status: 'processing',
      attemptCount: 1,
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
    });
    expect(decision.nextStatus).toBe('queued');
    expect(decision.delayMs).toBeGreaterThan(0);
  });

  it('試行回数が上限に達したら failed にして自動再試行を止める', () => {
    const decision = decideRetry({
      status: 'processing',
      attemptCount: DEFAULT_MAX_ATTEMPTS,
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
    });
    expect(decision.nextStatus).toBe('failed');
    expect(decision.delayMs).toBe(0);
  });

  it('上限を超えている場合も failed', () => {
    const decision = decideRetry({ status: 'processing', attemptCount: 99, maxAttempts: 5 });
    expect(decision.nextStatus).toBe('failed');
  });
});

describe('canCancelOnRefund（M-4 / INV-M4）', () => {
  it('processing 中のジョブは返金でも取り消さない', () => {
    // 外部へ送信済みの可能性があるため。取り消すと台帳と実態が乖離する。
    expect(canCancelOnRefund('processing')).toBe(false);
  });

  it('発行済み（succeeded）は取り消さない', () => {
    expect(canCancelOnRefund('succeeded')).toBe(false);
  });

  it('未送信のジョブ（queued / failed）は取り消せる', () => {
    expect(canCancelOnRefund('queued')).toBe(true);
    expect(canCancelOnRefund('failed')).toBe(true);
  });

  it('全状態について判定が定義されている', () => {
    for (const status of MINT_JOB_STATUSES) {
      expect(typeof canCancelOnRefund(status)).toBe('boolean');
    }
  });
});
