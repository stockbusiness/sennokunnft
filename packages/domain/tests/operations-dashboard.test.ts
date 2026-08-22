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
  openDisputeCount: 0,
  disputeDueSoonCount: 0,
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

  describe('カード会社との争い（2026-08-22）', () => {
    it('争いが無ければ平常', () => {
      expect(severityOf('dispute_open')?.severity).toBe('normal');
      expect(severityOf('dispute_open')?.action).toBeNull();
    });

    it('決着していない争いがあれば黄', () => {
      /*
        ⚠️ **黄。** 期限まで日があるうちから赤にすると、期限が迫った
           ものと同じ色になり、急ぐべきものが埋もれる。
      */
      const row = severityOf('dispute_open', { openDisputeCount: 1 });
      expect(row?.severity).toBe('warning');
      expect(row?.action).toBeTruthy();
    });

    it('提出期限が近ければ赤', () => {
      /*
        ⚠️ **過ぎると自動的に負ける。** こちらの言い分に関わらず、証拠を
           出さなかったという理由で敗訴になる。そのうえ返金は運営が被る。
      */
      const row = severityOf('dispute_open', { openDisputeCount: 2, disputeDueSoonCount: 1 });
      expect(row?.severity).toBe('critical');
      expect(row?.action).toBeTruthy();
    });

    it('急ぐときは、何件急ぐのかを文言に出す', () => {
      /*
        ⚠️ **「1 件ある」だけでは足りない。** 急ぐのかどうかが分からないと、
           運営は結局 決済事業者の画面を見に行くことになり、気づく仕組みを
           作った意味が半分になる。
      */
      const row = severityOf('dispute_open', { openDisputeCount: 5, disputeDueSoonCount: 3 });
      expect(row?.action).toContain('3');
      // ⚠️ 「過ぎたら負ける」ことを伝える。件数だけでは動く理由にならない。
      expect(row?.action).toContain('自動的に負けます');
    });

    it('件数は「決着していない数」を出す', () => {
      // ⚠️ 期限が近い数を出すと、まだ余裕のある争いが画面から消える。
      expect(
        severityOf('dispute_open', { openDisputeCount: 4, disputeDueSoonCount: 1 })?.count,
      ).toBe(4);
    });
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

/**
 * 止めている処理の色（2026-08-22）。
 *
 * ⚠️ ここで守っているのは **「消えない警告を作らないこと」** の一点。
 * 止めているあいだ心拍は増えないので、そのままでは黄色が永久に残る。
 * 消えない色があると、運営はその行を読み飛ばすようになり、**本当に
 * 止まった日にも気づけなくなる**。
 */
describe('止めている時計仕掛け', () => {
  const NEVER_RAN: readonly JobHeartbeat[] = Object.keys(JOB_LABELS).map((jobKey) => ({
    jobKey,
    lastSucceededAt: null,
    lastFailedAt: null,
    lastOutcome: null,
  }));

  function buildPaused(jobs: readonly JobHeartbeat[], pausedJobKeys: readonly string[]) {
    return buildIndicators({
      counts: QUIET,
      jobs,
      pausedJobKeys,
      thresholds: DEFAULT_OPERATIONS_THRESHOLDS,
      now: NOW,
    });
  }

  it('止めている処理は灰色（paused）になる', () => {
    const rows = buildPaused(NEVER_RAN, ['deliver-entitlements']);
    const row = rows.find((item) => item.key === 'job_deliver-entitlements');
    expect(row?.severity).toBe('paused');
    // ⚠️ 次にすることは無い。止まっているのが正しい状態である。
    expect(row?.action).toBeNull();
  });

  /*
    ⚠️ **止めていない処理まで灰色にしない。** 名前で選んでいるので、
       ここを取り違えると、動いているはずの処理の異常が丸ごと隠れる。
  */
  it('止めていない処理は今までどおり黄色のまま', () => {
    const rows = buildPaused(NEVER_RAN, ['deliver-entitlements']);
    const row = rows.find((item) => item.key === 'job_release-expired-reservations');
    expect(row?.severity).toBe('warning');
  });

  /*
    ⚠️ **止めていても項目ごと消さない。** 消すと「止めている」ではなく
       「そんな処理は無い」に見える。
  */
  it('止めていても項目は残る', () => {
    const rows = buildPaused(NEVER_RAN, ['deliver-entitlements']);
    expect(rows.some((item) => item.key === 'job_deliver-entitlements')).toBe(true);
  });

  it('止めている処理があっても全体は平常のまま', () => {
    expect(overallSeverity(buildPaused(NEVER_RAN, Object.keys(JOB_LABELS)))).toBe('normal');
  });

  /*
    ⚠️ **溜まっている数は隠れない。** 心拍を灰色にしても、お届け待ちの
       件数は別の項目として出続ける。ここが隠れると、フラグを下ろした
       まま注文を受け続けても誰も気づけない。
  */
  it('お届け待ちの件数は隠れない', () => {
    const rows = buildIndicators({
      counts: { ...QUIET, walletDeliveryPendingCount: 7 },
      jobs: NEVER_RAN,
      pausedJobKeys: ['deliver-entitlements'],
      thresholds: DEFAULT_OPERATIONS_THRESHOLDS,
      now: NOW,
    });
    const row = rows.find((item) => item.key === 'wallet_delivery_pending');
    expect(row?.count).toBe(7);
  });

  /*
    ⚠️ **止めていれば、長く動いていなくても赤にしない。** 一度動かして
       から止めた場合、心拍は古いまま残る。そこで赤くすると、止めた
       とたんに赤が点く。
  */
  it('一度動かしてから止めた処理も赤にしない', () => {
    const stale: readonly JobHeartbeat[] = Object.keys(JOB_LABELS).map((jobKey) => ({
      jobKey,
      lastSucceededAt: new Date('2026-08-01T00:00:00.000Z'),
      lastFailedAt: null,
      lastOutcome: 'succeeded' as const,
    }));
    const row = buildPaused(stale, ['deliver-entitlements']).find(
      (item) => item.key === 'job_deliver-entitlements',
    );
    expect(row?.severity).toBe('paused');
  });

  /*
    ⚠️ **既定は「何も止めていない」。** 渡し忘れた配備で、止めていない
       処理まで灰色になると、異常が丸ごと隠れる。
  */
  it('止めている種別を渡さなければ、今までどおりの色になる', () => {
    const row = buildIndicators({
      counts: QUIET,
      jobs: NEVER_RAN,
      thresholds: DEFAULT_OPERATIONS_THRESHOLDS,
      now: NOW,
    }).find((item) => item.key === 'job_deliver-entitlements');
    expect(row?.severity).toBe('warning');
  });
});
