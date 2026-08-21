import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRODUCTION_READINESS_THRESHOLDS,
  PRODUCTION_READINESS_CHECKS,
  evaluateProductionReadiness,
  type ProductionReadinessCheckKey,
  type ProductionReadinessFacts,
} from '../src/production/readiness';

/**
 * 本番販売ガード（実運営 指示書 P0-7）。
 *
 * ⚠️ ここで守っているのは **「証拠が無い＝未達」** の一点。
 * 記録が無いことを「たぶん大丈夫」と読んだ瞬間、この仕組みは何も守らない。
 */

const NOW = new Date('2026-08-21T00:00:00.000Z');
const CREDENTIAL_ID = 'cred-1';

/** 10 条件すべてを満たした状態。⚠️ ここから 1 つずつ崩して確かめる。 */
const READY: ProductionReadinessFacts = {
  acceptingCredential: {
    id: CREDENTIAL_ID,
    generation: 3,
    lastCheckSucceeded: true,
    lastCheckAt: new Date('2026-08-20T00:00:00.000Z'),
    lastWebhookReceivedAt: new Date('2026-08-20T12:00:00.000Z'),
  },
  platformFeeRateBps: 2000,
  publishedLegalKinds: ['terms', 'privacy', 'tokushoho'],
  walletCheck: { succeeded: true, executedAt: new Date('2026-08-20T00:00:00.000Z') },
  mailCheck: { succeeded: true, executedAt: new Date('2026-08-20T00:00:00.000Z') },
  jobs: [
    {
      jobKey: 'issue-entitlements',
      lastSucceededAt: new Date('2026-08-20T23:00:00.000Z'),
      lastFailedAt: null,
      lastOutcome: 'succeeded',
    },
    {
      jobKey: 'deliver-entitlements',
      lastSucceededAt: new Date('2026-08-20T23:00:00.000Z'),
      lastFailedAt: null,
      lastOutcome: 'succeeded',
    },
  ],
  owners: [{ accountId: 'owner-1', lastAal2At: new Date('2026-08-01T00:00:00.000Z') }],
  latestE2eSaleTest: {
    succeeded: true,
    credentialId: CREDENTIAL_ID,
    attestedAt: new Date('2026-08-20T00:00:00.000Z'),
  },
  latestOwnerApproval: {
    succeeded: true,
    credentialId: CREDENTIAL_ID,
    attestedAt: new Date('2026-08-20T00:00:00.000Z'),
  },
};

function evaluate(overrides: Partial<ProductionReadinessFacts> = {}, now: Date = NOW) {
  return evaluateProductionReadiness({
    facts: { ...READY, ...overrides },
    thresholds: DEFAULT_PRODUCTION_READINESS_THRESHOLDS,
    now,
  });
}

function checkOf(result: ReturnType<typeof evaluate>, key: ProductionReadinessCheckKey) {
  const row = result.checks.find((item) => item.key === key);
  expect(row, `条件 ${key} が見つからない`).toBeDefined();
  return row;
}

describe('10 条件がそろっているとき', () => {
  it('本番販売できる', () => {
    const result = evaluate();
    expect(result.ready).toBe(true);
    expect(result.unsatisfiedKeys).toEqual([]);
  });

  it('条件は 10 個で、順番も語彙どおり', () => {
    expect(evaluate().checks.map((row) => row.key)).toEqual([...PRODUCTION_READINESS_CHECKS]);
  });

  /*
    ⚠️ **満たしていても直し方を書いておく。** あとで崩れたときに、
       画面を見た人がその場で次の一手を読めるようにするため。
  */
  it('どの条件にも、次の一手が書いてある', () => {
    for (const row of evaluate().checks) {
      expect(row.remedy, `${row.key} に次の一手が無い`).toBeTruthy();
      expect(row.detail, `${row.key} に状態の説明が無い`).toBeTruthy();
    }
  });
});

describe('何も無いとき', () => {
  const EMPTY: ProductionReadinessFacts = {
    acceptingCredential: null,
    platformFeeRateBps: 0,
    publishedLegalKinds: [],
    walletCheck: null,
    mailCheck: null,
    jobs: [],
    owners: [],
    latestE2eSaleTest: null,
    latestOwnerApproval: null,
  };

  /*
    ⚠️ **これが基準の姿。** 立ち上げた直後は 10 個すべて未達で、
       ひとつずつ満たしていく。既定で通ってしまう作りにしない。
  */
  it('10 個すべて未達', () => {
    const result = evaluateProductionReadiness({
      facts: EMPTY,
      thresholds: DEFAULT_PRODUCTION_READINESS_THRESHOLDS,
      now: NOW,
    });
    expect(result.ready).toBe(false);
    expect(result.unsatisfiedKeys).toHaveLength(PRODUCTION_READINESS_CHECKS.length);
  });
});

describe('条件を 1 つずつ崩す', () => {
  it('受付中の決済世代が無ければ通らない', () => {
    const result = evaluate({ acceptingCredential: null });
    expect(result.ready).toBe(false);
    expect(checkOf(result, 'payment_credential_active')?.satisfied).toBe(false);
  });

  it('決済の接続確認が済んでいなければ通らない', () => {
    const result = evaluate({
      acceptingCredential: { ...READY.acceptingCredential!, lastCheckSucceeded: null },
    });
    expect(checkOf(result, 'payment_credential_active')?.satisfied).toBe(false);
  });

  /*
    ⚠️ **「署名鍵が入っている」では足りない。** 入れ間違えても、
       受け取るまで誰も気づかない。届いた事実で見る。
  */
  it('決済の知らせを一度も受け取っていなければ通らない', () => {
    const result = evaluate({
      acceptingCredential: { ...READY.acceptingCredential!, lastWebhookReceivedAt: null },
    });
    expect(checkOf(result, 'webhook_signature_configured')?.satisfied).toBe(false);
  });

  /*
    ⚠️ **0 は「無料」ではなく「まだ決めていない」。**
  */
  it('手数料率が 0 なら通らない', () => {
    const result = evaluate({ platformFeeRateBps: 0 });
    expect(checkOf(result, 'platform_fee_rate_approved')?.satisfied).toBe(false);
  });

  it.each([
    ['利用規約', ['privacy', 'tokushoho']],
    ['プライバシーポリシー', ['terms', 'tokushoho']],
    ['特商法表記', ['terms', 'privacy']],
  ] as const)('%s が施行されていなければ通らない', (_label, kinds) => {
    const result = evaluate({ publishedLegalKinds: [...kinds] });
    expect(checkOf(result, 'legal_documents_published')?.satisfied).toBe(false);
  });

  it.each([
    ['wallet_connection_verified', 'walletCheck'],
    ['mail_connection_verified', 'mailCheck'],
  ] as const)('%s は、一度も確かめていなければ通らない', (key, field) => {
    const result = evaluate({ [field]: null } as Partial<ProductionReadinessFacts>);
    expect(checkOf(result, key)?.satisfied).toBe(false);
  });

  it.each([
    ['wallet_connection_verified', 'walletCheck'],
    ['mail_connection_verified', 'mailCheck'],
  ] as const)('%s は、直近の確認が失敗していれば通らない', (key, field) => {
    const result = evaluate({
      [field]: { succeeded: false, executedAt: new Date('2026-08-20T00:00:00.000Z') },
    } as Partial<ProductionReadinessFacts>);
    expect(checkOf(result, key)?.satisfied).toBe(false);
  });

  /*
    ⚠️ **一度通ったことを永久の証拠にしない。** 相手側の証明書も鍵も
       入れ替わる。切れていることに、売れなくなってから気づく。
  */
  it.each([
    ['wallet_connection_verified', 'walletCheck'],
    ['mail_connection_verified', 'mailCheck'],
  ] as const)('%s は、確認が古すぎれば通らない', (key, field) => {
    const result = evaluate({
      [field]: { succeeded: true, executedAt: new Date('2026-06-01T00:00:00.000Z') },
    } as Partial<ProductionReadinessFacts>);
    expect(checkOf(result, key)?.satisfied).toBe(false);
  });

  it.each(['issue-entitlements', 'deliver-entitlements'] as const)(
    '%s が動いていなければ通らない',
    (jobKey) => {
      const result = evaluate({ jobs: READY.jobs.filter((job) => job.jobKey !== jobKey) });
      expect(checkOf(result, 'jobs_running')?.satisfied).toBe(false);
    },
  );

  it('時計が止まって時間が経っていれば通らない', () => {
    const result = evaluate({
      jobs: READY.jobs.map((job) => ({
        ...job,
        // 150 分より前。
        lastSucceededAt: new Date('2026-08-20T18:00:00.000Z'),
      })),
    });
    expect(checkOf(result, 'jobs_running')?.satisfied).toBe(false);
  });

  /*
    ⚠️ **責任を引き受ける人が居ない状態で売り始めない。**
  */
  it('オーナーが 0 人なら通らない', () => {
    const result = evaluate({ owners: [] });
    expect(checkOf(result, 'admin_mfa_satisfied')?.satisfied).toBe(false);
  });

  it('二要素で入った記録が無いオーナーが 1 人でも居れば通らない', () => {
    const result = evaluate({
      owners: [
        { accountId: 'owner-1', lastAal2At: new Date('2026-08-01T00:00:00.000Z') },
        { accountId: 'owner-2', lastAal2At: null },
      ],
    });
    expect(checkOf(result, 'admin_mfa_satisfied')?.satisfied).toBe(false);
  });

  it('二要素の記録が古すぎれば通らない', () => {
    const result = evaluate({
      owners: [{ accountId: 'owner-1', lastAal2At: new Date('2026-01-01T00:00:00.000Z') }],
    });
    expect(checkOf(result, 'admin_mfa_satisfied')?.satisfied).toBe(false);
  });
});

describe('人が残す証跡', () => {
  it.each([
    ['e2e_sale_test_passed', 'latestE2eSaleTest'],
    ['owner_approval_recorded', 'latestOwnerApproval'],
  ] as const)('%s は、記録が無ければ通らない', (key, field) => {
    const result = evaluate({ [field]: null } as Partial<ProductionReadinessFacts>);
    expect(checkOf(result, key)?.satisfied).toBe(false);
  });

  /*
    ⚠️ **「最新のものが成功しているか」を見る。** 過去のどこかに成功が
       あることではない。直したなら、直したあとの記録を残す。
  */
  it.each([
    ['e2e_sale_test_passed', 'latestE2eSaleTest'],
    ['owner_approval_recorded', 'latestOwnerApproval'],
  ] as const)('%s は、直近が不成立なら通らない', (key, field) => {
    const result = evaluate({
      [field]: {
        succeeded: false,
        credentialId: CREDENTIAL_ID,
        attestedAt: new Date('2026-08-20T00:00:00.000Z'),
      },
    } as Partial<ProductionReadinessFacts>);
    expect(checkOf(result, key)?.satisfied).toBe(false);
  });

  /*
    ⚠️ **この試験がいちばん大事。** 鍵が替わるのは、運営会社や入金先が
       変わるということ。前の鍵で通した試験は、新しい鍵の証拠にならない。
  */
  it.each([
    ['e2e_sale_test_passed', 'latestE2eSaleTest'],
    ['owner_approval_recorded', 'latestOwnerApproval'],
  ] as const)('%s は、決済の鍵が替われば失効する', (key, field) => {
    const result = evaluate({
      [field]: {
        succeeded: true,
        credentialId: 'cred-0',
        attestedAt: new Date('2026-08-20T00:00:00.000Z'),
      },
    } as Partial<ProductionReadinessFacts>);
    expect(checkOf(result, key)?.satisfied).toBe(false);
    expect(checkOf(result, key)?.detail).toContain('替わった');
  });
});
