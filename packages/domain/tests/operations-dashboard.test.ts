import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OPERATIONS_THRESHOLDS,
  JOB_LABELS,
  buildIndicators,
  overallSeverity,
  type JobHeartbeat,
  type OperationsCounts,
} from '../src/operations/dashboard';

/**
 * 運営ダッシュボードの判定（実運営 指示書 P0-6）。
 *
 * ⚠️ ここで守っているのは **「赤が意味を持つこと」** の一点に尽きる。
 * 待ちを赤にした瞬間、この画面は毎朝赤くなり、誰も見なくなる。
 */

const NOW = new Date('2026-08-21T09:00:00.000Z');

const QUIET: OperationsCounts = {
  todayOrderCount: 0,
  todayPaidAmount: 0,
  todayPaidCount: 0,
  todayPaymentFailedCount: 0,
  issuancePendingCount: 0,
  issuanceFailedCount: 0,
  walletDeliveryPendingCount: 0,
  walletDeliveryFailedCount: 0,
  operationsReviewOpenCount: 0,
  notificationPendingCount: 0,
  notificationFailedCount: 0,
  integrationFailureCount: 0,
  lastWebhookReceivedAt: new Date('2026-08-21T08:00:00.000Z'),
};

const HEALTHY_JOBS: readonly JobHeartbeat[] = Object.keys(JOB_LABELS).map((jobKey) => ({
  jobKey,
  lastSucceededAt: new Date('2026-08-21T08:30:00.000Z'),
  lastFailedAt: null,
  lastOutcome: 'succeeded' as const,
}));

function build(
  counts: Partial<OperationsCounts> = {},
  jobs: readonly JobHeartbeat[] = HEALTHY_JOBS,
  now: Date = NOW,
) {
  return buildIndicators({
    counts: { ...QUIET, ...counts },
    jobs,
    thresholds: DEFAULT_OPERATIONS_THRESHOLDS,
    now,
  });
}

function severityOf(key: string, counts: Partial<OperationsCounts> = {}, jobs = HEALTHY_JOBS) {
  const row = build(counts, jobs).find((item) => item.key === key);
  expect(row, `指標 ${key} が見つからない`).toBeDefined();
  return row;
}

describe('運営ダッシュボードの深刻度', () => {
  it('何も起きていなければ全体は平常', () => {
    expect(overallSeverity(build())).toBe('normal');
  });

  /*
    ⚠️ **この試験がいちばん大事。** 待ちが溜まっているのは仕組みが
       動いている証拠で、次の巡回で減る。赤くしてはいけない。
  */
  it.each([
    ['issuance_pending', { issuancePendingCount: 40 }],
    ['wallet_delivery_pending', { walletDeliveryPendingCount: 40 }],
    ['notification_pending', { notificationPendingCount: 40 }],
  ] as const)('%s は件数が多くても赤にならない', (key, counts) => {
    expect(severityOf(key, counts)?.severity).toBe('normal');
    expect(overallSeverity(build(counts))).toBe('normal');
  });

  it.each([
    ['issuance_failed', { issuanceFailedCount: 1 }],
    ['operations_review_open', { operationsReviewOpenCount: 1 }],
    ['notification_failed', { notificationFailedCount: 1 }],
  ] as const)('%s は 1 件でも赤になり、次の一手が付く', (key, counts) => {
    const row = severityOf(key, counts);
    expect(row?.severity).toBe('critical');
    // ⚠️ 「異常です」だけでは、受け取った人が動けない。
    expect(row?.action).toBeTruthy();
  });

  it('赤い指標には必ず次の一手が添えられる', () => {
    const rows = build({
      issuanceFailedCount: 1,
      operationsReviewOpenCount: 2,
      notificationFailedCount: 3,
      walletDeliveryFailedCount: 4,
      integrationFailureCount: 5,
    });
    for (const row of rows) {
      if (row.severity === 'normal') {
        continue;
      }
      expect(row.action, `${row.key} に次の一手が無い`).toBeTruthy();
    }
  });

  it('ウォレットのお届け失敗は黄色に留まる（相手側の障害が多いため）', () => {
    expect(severityOf('wallet_delivery_failed', { walletDeliveryFailedCount: 3 })?.severity).toBe(
      'warning',
    );
  });

  it('お支払いの不成立は日常なので色を付けない', () => {
    expect(severityOf('today_payment_failed', { todayPaymentFailedCount: 12 })?.severity).toBe(
      'normal',
    );
  });
});

describe('時計仕掛けの生死', () => {
  it('しきい値を超えて成功していなければ赤', () => {
    const stale: readonly JobHeartbeat[] = [
      {
        jobKey: 'issue-entitlements',
        // 150 分より前。
        lastSucceededAt: new Date('2026-08-21T06:00:00.000Z'),
        lastFailedAt: null,
        lastOutcome: 'succeeded',
      },
    ];
    const row = build({}, stale).find((item) => item.key === 'job_issue-entitlements');
    expect(row?.severity).toBe('critical');
    expect(row?.action).toBeTruthy();
  });

  /*
    ⚠️ **一度も成功していないことを赤にしない。** 繋ぐ前ならこれが正常。
       立ち上げの日から赤で埋まると、赤の意味が最初から失われる。
  */
  it('一度も成功していないだけなら黄色', () => {
    const fresh: readonly JobHeartbeat[] = [
      {
        jobKey: 'issue-entitlements',
        lastSucceededAt: null,
        lastFailedAt: null,
        lastOutcome: null,
      },
    ];
    expect(build({}, fresh).find((item) => item.key === 'job_issue-entitlements')?.severity).toBe(
      'warning',
    );
  });

  it('直近で失敗していても、しきい値内に成功していれば赤にしない', () => {
    const flapping: readonly JobHeartbeat[] = [
      {
        jobKey: 'send-notifications',
        lastSucceededAt: new Date('2026-08-21T08:50:00.000Z'),
        lastFailedAt: new Date('2026-08-21T08:55:00.000Z'),
        lastOutcome: 'failed',
      },
    ];
    expect(
      build({}, flapping).find((item) => item.key === 'job_send-notifications')?.severity,
    ).toBe('normal');
  });

  it('運営に伝わる言葉で出す（内部の識別子を画面へ出さない）', () => {
    const row = build().find((item) => item.key === 'job_issue-entitlements');
    expect(row?.label).toBe('受取権の発行の最終成功');
    expect(row?.label).not.toContain('issue-entitlements');
  });
});

describe('決済の知らせ', () => {
  /*
    ⚠️ **静かなことを赤で断言しない。** ご注文が無ければ知らせも来ない。
       売れていない日と壊れている日を、ここからは区別できない。
  */
  it('長く静かでも黄色まで', () => {
    const row = build({ lastWebhookReceivedAt: new Date('2026-08-18T00:00:00.000Z') }).find(
      (item) => item.key === 'webhook_last_received',
    );
    expect(row?.severity).toBe('warning');
  });

  it('一度も受け取っていなければ黄色（繋ぐ前なら正常）', () => {
    const row = build({ lastWebhookReceivedAt: null }).find(
      (item) => item.key === 'webhook_last_received',
    );
    expect(row?.severity).toBe('warning');
    expect(row?.action).toBeTruthy();
  });
});

describe('全体の色', () => {
  it('赤が 1 つでもあれば全体は赤', () => {
    expect(overallSeverity(build({ issuanceFailedCount: 1, integrationFailureCount: 9 }))).toBe(
      'critical',
    );
  });

  it('黄色だけなら黄色', () => {
    expect(overallSeverity(build({ integrationFailureCount: 1 }))).toBe('warning');
  });
});
