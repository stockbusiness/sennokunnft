import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  createDevToken,
  DevTokenVerifier,
  InMemoryNonceStore,
  InMemoryRateLimiter,
  SenNoKuniHmacVerifier,
  Sha256ClaimTokenService,
} from '@sengoku/integrations';
import { createLogger } from '@sengoku/observability';
import type { ClaimTokenRotationSource } from '../src/claim/reissue.service';
import type { Role } from '@sengoku/auth';
import { AppModule } from '../src/app.module';
import { DomainErrorFilter } from '../src/common/domain-error.filter';
import {
  buildHarness,
  TEST_AUDIENCE,
  TEST_INTERNAL_JOB_TOKEN,
  TEST_ISSUER,
  TEST_NOW,
  TEST_TOKEN_SECRET,
  type TestHarness,
} from './helpers/doubles';

/**
 * 運営ダッシュボード（実運営 指示書 P0-6）。
 *
 * ⚠️ **この組の主題は 4 つ。**
 *  1. **見るのと動かすのを分けること。** 監査担当は数を見られるが、
 *     外部へ送り直すことはできない
 *  2. **個人を特定できる値が応答に混ざらないこと**（`UD-503`）
 *  3. **時計仕掛けが動いたことが残ること。** 止まった時計に気づけるのは
 *     ここだけで、記録が無ければ「止まっている」と「一度も動いていない」を
 *     区別できない
 *  4. **禁じた操作の口が無いこと。** 金額の書き換え・`paid` への手動変更・
 *     記録を残さない状態変更を、この画面から起こせないこと
 */

let app: INestApplication;
let harness: TestHarness;

const ACCOUNT_ID = 'c0ffee00-0000-4000-8000-000000000001';
const ORDER_ID = 'c0ffee00-0000-4000-8000-000000000002';
const ENTITLEMENT_ID = 'c0ffee00-0000-4000-8000-000000000003';

function tokenFor(subject: string): string {
  return createDevToken(TEST_TOKEN_SECRET, {
    sub: subject,
    iss: TEST_ISSUER,
    aud: TEST_AUDIENCE,
    exp: Math.floor(TEST_NOW.getTime() / 1000) + 3600,
  });
}

function actorToken(role: Role, subject = `user-${role}`): string {
  harness.accounts.seed(subject, role);
  return tokenFor(subject);
}

function auth(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

function seedEntitlement(overrides: Record<string, unknown> = {}): void {
  harness.entitlementAdmin.rows = [
    {
      id: ENTITLEMENT_ID,
      orderId: ORDER_ID,
      orderNumber: 'SNK-20260821-0001',
      orderLineId: 'c0ffee00-0000-4000-8000-000000000004',
      accountId: ACCOUNT_ID,
      artworkId: 'c0ffee00-0000-4000-8000-000000000005',
      artworkTitle: 'サンプル作品',
      serialNo: 1,
      status: 'claimed',
      walletDeliveryStatus: 'pending',
      claimedByCommonUserId: 'common-user-1',
      claimedAt: TEST_NOW,
      walletDeliveredAt: null,
      createdAt: TEST_NOW,
      deliveries: [],
      ...overrides,
    },
  ];
}

/**
 * 受取権を 1 件も返さない配送元（試験用）。
 *
 * ⚠️ **本物の配送を組み立てない。** ここで確かめたいのは「押した人と
 * 件数が記録に残ること」であって、Wallet へ何が届くかではない。
 * 届く中身は `auto-delivery.test.ts` が受け持っている。
 */
function emptyClaims(): ClaimTokenRotationSource {
  return {
    findForAutoDelivery: () => Promise.resolve(null),
    listAutoDeliverable: () => Promise.resolve([]),
  } as unknown as ClaimTokenRotationSource;
}

/**
 * 組み立て。
 *
 * ⚠️ **配送を有効にするかを選べるようにしてある。** 既定は無効で、
 * それが「まだ Wallet へ繋いでいない配備」の姿。送り直しの口は
 * その配備でも生えていて、押されたら断る（口ごと消すと、画面が
 * 配備ごとに変わってしまう）。
 */
async function boot(options: { readonly deliveryEnabled?: boolean } = {}): Promise<void> {
  harness = buildHarness(
    new DevTokenVerifier({
      secret: TEST_TOKEN_SECRET,
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
      now: () => TEST_NOW,
    }),
  );
  const deps =
    options.deliveryEnabled === true
      ? {
          ...harness,
          claim: {
            enabled: true,
            claims: emptyClaims(),
            tokens: new Sha256ClaimTokenService(),
            verifier: new SenNoKuniHmacVerifier({
              secrets: { 'wallet-test': 'wallet-test-secret' },
              nonces: new InMemoryNonceStore(),
            }),
            logger: createLogger({ service: 'test', level: 'fatal' }),
            rateLimiter: new InMemoryRateLimiter(),
            claimBaseUrl: 'https://example.test/claims',
            deliveryEnabled: true,
            getPerMinute: 3000,
            postPerMinute: 300,
          },
        }
      : harness;

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.register(deps)],
  }).compile();
  app = moduleRef.createNestApplication({ rawBody: true });
  app.useGlobalFilters(new DomainErrorFilter());
  await app.init();
}

beforeEach(async () => {
  await boot();
});

afterEach(async () => {
  await app.close();
});

describe('誰が見て、誰が動かせるか', () => {
  it('未認証では見られない', async () => {
    await request(app.getHttpServer()).get('/api/v1/admin/operations/dashboard').expect(401);
  });

  it('会員は見られない', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/operations/dashboard')
      .set(auth(actorToken('buyer')))
      .expect(403);
  });

  it('監査担当は見られる（残件が見えないと監査にならない）', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/operations/dashboard')
      .set(auth(actorToken('auditor')))
      .expect(200);
  });

  /*
    ⚠️ **見るのと動かすのは別。** 送り直しは外部へ実際に送る操作で、
       監査担当の職務ではない。
  */
  it('監査担当は発行し直せない', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/admin/operations/orders/${ORDER_ID}/retry-issuance`)
      .set(auth(actorToken('auditor')))
      .expect(403);
  });

  it('監査担当は送り直せない', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/admin/operations/accounts/${ACCOUNT_ID}/redeliver`)
      .set(auth(actorToken('auditor')))
      .expect(403);
  });
});

describe('指標の色', () => {
  it('何も起きていなければ全体は平常', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/operations/dashboard')
      .set(auth(actorToken('operator')))
      .expect(200);
    // ⚠️ 時計が一度も動いていないので黄色。赤ではない。
    expect(response.body.overall).not.toBe('critical');
  });

  it('発行を打ち切った注文があれば赤になり、次の一手が付く', async () => {
    harness.operationsMetrics.counts_ = {
      ...harness.operationsMetrics.counts_,
      issuanceFailedCount: 2,
    };
    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/operations/dashboard')
      .set(auth(actorToken('operator')))
      .expect(200);

    expect(response.body.overall).toBe('critical');
    const row = response.body.indicators.find(
      (item: { key: string }) => item.key === 'issuance_failed',
    );
    expect(row.severity).toBe('critical');
    expect(row.action).toBeTruthy();
  });

  /*
    ⚠️ **待ちは赤にしない。** 赤くすると毎朝赤くなり、運営は見なくなる。
  */
  it('待ちがいくら溜まっても赤にならない', async () => {
    harness.operationsMetrics.counts_ = {
      ...harness.operationsMetrics.counts_,
      issuancePendingCount: 500,
      walletDeliveryPendingCount: 500,
      notificationPendingCount: 500,
    };
    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/operations/dashboard')
      .set(auth(actorToken('operator')))
      .expect(200);
    const pending = response.body.indicators.filter((item: { key: string }) =>
      item.key.endsWith('_pending'),
    );
    expect(pending).not.toHaveLength(0);
    expect(pending.every((item: { severity: string }) => item.severity === 'normal')).toBe(true);
  });

  /*
    ⚠️ **応答に個人を特定できる値を混ぜない**（`UD-503`）。項目そのものが
       契約に無いので載せようが無い——という状態を保つ。
  */
  it('応答に個人を特定できる値が入らない', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/operations/dashboard')
      .set(auth(actorToken('operator')))
      .expect(200);
    const body = JSON.stringify(response.body);
    expect(body).not.toMatch(/@/);
    for (const forbidden of ['email', 'name', 'phone', 'address']) {
      expect(body.toLowerCase()).not.toContain(forbidden);
    }
  });
});

describe('記録の食い違い', () => {
  it('食い違いが無くても、調べた項目をすべて返す', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/operations/consistency')
      .set(auth(actorToken('operator')))
      .expect(200);
    // ⚠️ 0 件の項目を消すと「調べたのか」が分からない。
    expect(response.body.findings).toHaveLength(5);
    expect(response.body.overall).toBe('normal');
  });

  it('見つかれば件数と手がかりを返す', async () => {
    harness.operationsMetrics.consistency_ = {
      ...harness.operationsMetrics.consistency_,
      paidWithoutEntitlements: [ORDER_ID],
    };
    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/operations/consistency')
      .set(auth(actorToken('operator')))
      .expect(200);
    expect(response.body.overall).toBe('critical');
    const row = response.body.findings.find(
      (item: { key: string }) => item.key === 'paid_without_entitlements',
    );
    expect(row.count).toBe(1);
    expect(row.sampleIds).toEqual([ORDER_ID]);
  });

  /*
    ⚠️ **直す口を作らない。** 黙って直すと、なぜ食い違ったのかが
       分からないまま同じことが繰り返される。
  */
  it('食い違いを直す口は無い', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/admin/operations/consistency')
      .set(auth(actorToken('operator')))
      .expect(404);
  });
});

describe('受取権の一覧', () => {
  it('氏名やメールを返さない', async () => {
    seedEntitlement();
    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/operations/entitlements')
      .set(auth(actorToken('operator')))
      .expect(200);
    const row = response.body.items[0];
    expect(row.orderNumber).toBe('SNK-20260821-0001');
    expect(Object.keys(row)).not.toContain('buyerEmail');
    expect(Object.keys(row)).not.toContain('buyerName');
  });

  /*
    ⚠️ **お受け取りの合言葉を載せない。** 一覧に出ると、画面を見られた
       だけで他人が受け取れてしまう。
  */
  it('お受け取りの合言葉を返さない', async () => {
    seedEntitlement();
    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/operations/entitlements')
      .set(auth(actorToken('operator')))
      .expect(200);
    const body = JSON.stringify(response.body).toLowerCase();
    expect(body).not.toContain('claimtoken');
    expect(body).not.toContain('token');
  });

  it('無い受取権は 404', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/admin/operations/entitlements/${ENTITLEMENT_ID}`)
      .set(auth(actorToken('operator')))
      .expect(404);
  });

  it('詳細ではお届けの本文を返さない', async () => {
    seedEntitlement({
      deliveries: [
        {
          id: 'c0ffee00-0000-4000-8000-000000000006',
          eventId: 'evt-1',
          eventType: 'entitlement.granted',
          status: 'FAILED',
          attemptCount: 3,
          lastErrorCode: 'HTTP_502',
          deliveredAt: null,
          createdAt: TEST_NOW,
        },
      ],
    });
    const response = await request(app.getHttpServer())
      .get(`/api/v1/admin/operations/entitlements/${ENTITLEMENT_ID}`)
      .set(auth(actorToken('operator')))
      .expect(200);
    expect(response.body.deliveries[0].lastErrorCode).toBe('HTTP_502');
    expect(Object.keys(response.body.deliveries[0])).not.toContain('payload');
  });
});

describe('やり直しの操作', () => {
  /*
    ⚠️ **何も起きなかったことを隠さない。** 黙って 200 を返すと、
       押した人は「直った」と思って次へ進む。
  */
  it('発行するものが無ければ、そう答える', async () => {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/admin/operations/orders/${ORDER_ID}/retry-issuance`)
      .set(auth(actorToken('operator')))
      .expect(201);
    expect(response.body.alreadyComplete).toBe(true);
    expect(response.body.issuedCount).toBe(0);
  });

  /*
    ⚠️ **繋いでいない配備では、口はあるが断る。** 口ごと消すと、
       画面が配備ごとに変わってしまい、「押せるはずのボタンが無い」
       という問い合わせに変わる。
  */
  it('配送を有効にしていない配備では、送り直しを断る', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/admin/operations/accounts/${ACCOUNT_ID}/redeliver`)
      .set(auth(actorToken('operator')))
      .expect(503);
  });

  it('送り直すものが無ければ、拾った件数は 0', async () => {
    await boot({ deliveryEnabled: true });
    const response = await request(app.getHttpServer())
      .post(`/api/v1/admin/operations/accounts/${ACCOUNT_ID}/redeliver`)
      .set(auth(actorToken('operator')))
      .expect(201);
    expect(response.body.pickedCount).toBe(0);
  });

  /*
    ⚠️ **押した人を記録する。** お金を受け取った注文に対して、
       外部にも影響しうる処理を人が起こす操作である。
  */
  it('やり直しは操作の記録に残る', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/admin/operations/orders/${ORDER_ID}/retry-issuance`)
      .set(auth(actorToken('operator')))
      .expect(201);
    const recorded = harness.audit.entries.filter(
      (row) => row.action === 'operations.retry_issuance',
    );
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.targetId).toBe(ORDER_ID);
  });

  it('送り直しも操作の記録に残る', async () => {
    await boot({ deliveryEnabled: true });
    seedEntitlement();
    await request(app.getHttpServer())
      .post(`/api/v1/admin/operations/accounts/${ACCOUNT_ID}/redeliver`)
      .set(auth(actorToken('operator')))
      .expect(201);
    const recorded = harness.audit.entries.filter((row) => row.action === 'operations.redeliver');
    expect(recorded).toHaveLength(1);
    // ⚠️ 受取権の識別子を並べない。件数まで。
    expect(JSON.stringify(recorded[0]?.summary)).not.toContain(ENTITLEMENT_ID);
    /*
      ⚠️ **届かなくても記録は残る。** 「押したが届かなかった」ことこそ、
         あとから辿れなければならない。
    */
    expect(recorded[0]?.summary).toMatchObject({ pickedCount: 1, deliveredCount: 0 });
  });
});

describe('禁じた操作の口が無いこと（P0/P1 §9.3）', () => {
  it.each([
    ['金額の書き換え', `/api/v1/admin/operations/orders/${ORDER_ID}/amount`],
    ['支払い済みへの手動変更', `/api/v1/admin/operations/orders/${ORDER_ID}/mark-paid`],
    ['受取権の物理削除', `/api/v1/admin/operations/entitlements/${ENTITLEMENT_ID}/delete`],
  ])('%s の口は存在しない', async (_label, path) => {
    /*
      ⚠️ **運営の権限で叩いて 404 であることを確かめる。** 403 だと
         「権限さえあれば通る口がある」ことになり、意味が変わってしまう。
    */
    await request(app.getHttpServer())
      .post(path)
      .set(auth(actorToken('operator')))
      .expect(404);
  });
});

describe('時計仕掛けの記録', () => {
  /*
    ⚠️ **止まった時計に気づけるのはここだけ。** 記録が無ければ
       「止まっている」と「一度も動いていない」を区別できない。
  */
  it('cron が動くと最終成功が残る', async () => {
    expect(harness.operationsMetrics.jobRuns.get('issue-entitlements')).toBeUndefined();

    await request(app.getHttpServer())
      .post('/api/v1/internal/jobs/issue-entitlements')
      .set({ 'X-Internal-Job-Token': TEST_INTERNAL_JOB_TOKEN })
      .expect(200);

    const row = harness.operationsMetrics.jobRuns.get('issue-entitlements');
    expect(row?.lastOutcome).toBe('succeeded');
    expect(row?.lastSucceededAt).not.toBeNull();
  });

  it('記録が残ると、ダッシュボードの黄色が消える', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/internal/jobs/issue-entitlements')
      .set({ 'X-Internal-Job-Token': TEST_INTERNAL_JOB_TOKEN })
      .expect(200);

    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/operations/dashboard')
      .set(auth(actorToken('operator')))
      .expect(200);
    const row = response.body.indicators.find(
      (item: { key: string }) => item.key === 'job_issue-entitlements',
    );
    expect(row.severity).toBe('normal');
  });

  /*
    ⚠️ **認可を通っていない呼び出しを「成功」として記録しない。**
       記録できてしまうと、合言葉を知らない誰かが叩くだけで
       「時計は動いている」ことにできる。
  */
  it('合言葉が違えば記録しない', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/internal/jobs/issue-entitlements')
      .set({ 'X-Internal-Job-Token': 'wrong-token' })
      .expect(401);
    expect(harness.operationsMetrics.jobRuns.get('issue-entitlements')).toBeUndefined();
  });
});

/*
  カード会社との争いの一覧（2026-08-22）。

  ⚠️ ここで守りたいのは 3 つ。
    1. **買った方を特定できる値を返さないこと**（`UD-503`）。一覧は広く
       開く画面で、返したものはそのまま目に触れる。
    2. **期限の早い順に出ること。** 起きた順だと、期限が明日のものが沈む。
    3. **状態を変える口が無いこと。** 正は決済事業者の記録である。
*/
describe('争いの一覧', () => {
  /** ⚠️ 試験の時計は `TEST_NOW`（2026-06-01）。日付はそこを基準に置く。 */
  const OPENED = new Date('2026-05-20T00:00:00.000Z');

  async function seedDispute(
    disputeRef: string,
    evidenceDueAt: Date | null,
    status: 'needs_response' | 'won' = 'needs_response',
  ): Promise<void> {
    const orderId = `order-${disputeRef}`;
    harness.disputes.orderFacts.set(orderId, {
      orderNumber: `SNK-${disputeRef}`,
      artworkTitleSnapshot: '争いの試験の作品',
      total: 3000,
    });
    await harness.disputes.record({
      id: `dispute-${disputeRef}`,
      orderId,
      paymentId: null,
      provider: 'fake',
      disputeRef,
      status,
      reason: 'fraudulent',
      amount: 3000,
      currency: 'JPY',
      evidenceDueAt,
      occurredAt: OPENED,
      now: OPENED,
    });
  }

  it('閲覧者にも開く', async () => {
    /*
      ⚠️ **額を動かす操作は無い。** 対応漏れが残っていないかは監査の対象
         そのものなので、閲覧者にも見えている必要がある。
    */
    await request(app.getHttpServer())
      .get('/api/v1/admin/operations/disputes')
      .set(auth(actorToken('auditor')))
      .expect(200);
  });

  it('買った方には見せない', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/operations/disputes')
      .set(auth(actorToken('buyer')))
      .expect(403);
  });

  it('期限の早い順に出る', async () => {
    await seedDispute('late', new Date('2026-09-30T00:00:00.000Z'));
    await seedDispute('soon', new Date('2026-06-02T00:00:00.000Z'));

    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/operations/disputes')
      .set(auth(actorToken('operator')))
      .expect(200);

    expect(response.body.items.map((row: { disputeRef: string }) => row.disputeRef)).toEqual([
      'soon',
      'late',
    ]);
  });

  it('買った方を特定できる値を返さない', async () => {
    /*
      ⚠️ **本文まるごとを見る。** 項目名を 1 つずつ確かめる形にすると、
         あとから足された項目を見落とす。
    */
    await seedDispute('privacy', new Date('2026-06-02T00:00:00.000Z'));

    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/operations/disputes')
      .set(auth(actorToken('operator')))
      .expect(200);

    const body = JSON.stringify(response.body);
    for (const forbidden of ['email', 'Email', 'buyerName', 'phone', 'address', 'accountId']) {
      expect(body, forbidden).not.toContain(forbidden);
    }
  });

  it('決着したものは既定で出ない', async () => {
    await seedDispute('open-one', null);
    await seedDispute('won-one', null, 'won');

    const open = await request(app.getHttpServer())
      .get('/api/v1/admin/operations/disputes')
      .set(auth(actorToken('operator')))
      .expect(200);
    expect(open.body.items.map((row: { disputeRef: string }) => row.disputeRef)).toEqual([
      'open-one',
    ]);

    const closed = await request(app.getHttpServer())
      .get('/api/v1/admin/operations/disputes?state=closed')
      .set(auth(actorToken('operator')))
      .expect(200);
    expect(closed.body.items.map((row: { disputeRef: string }) => row.disputeRef)).toEqual([
      'won-one',
    ]);
  });

  it('急ぎ具合と、期限が近いの境目を返す', async () => {
    /*
      ⚠️ **境目を画面へ渡す。** 画面に定数で持たせると、しきい値を変える
         たびにデプロイが要る。
    */
    // ⚠️ 時計より前＝すでに過ぎている。
    await seedDispute('urgent', new Date('2026-05-25T00:00:00.000Z'));

    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/operations/disputes')
      .set(auth(actorToken('operator')))
      .expect(200);

    expect(response.body.dueSoonDays).toBeGreaterThan(0);
    // ⚠️ すでに過ぎている。決着と混ぜない。
    expect(response.body.items[0].urgency).toBe('overdue');
  });

  it('状態を変える口は無い', async () => {
    /*
      ⚠️ **正は決済事業者の記録。** こちらに口を作ると、あちらとこちらで
         食い違う。作っていないことを試験で押さえておく。
    */
    await seedDispute('readonly', null);
    await request(app.getHttpServer())
      .post('/api/v1/admin/operations/disputes/dispute-readonly/close')
      .set(auth(actorToken('operator')))
      .expect(404);
  });
});
