import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createDevToken, DevTokenVerifier } from '@sengoku/integrations';
import type { Role } from '@sengoku/auth';
import type { PayoutCandidate } from '@sengoku/domain';
import { AppModule } from '../src/app.module';
import { DomainErrorFilter } from '../src/common/domain-error.filter';
import {
  buildHarness,
  TEST_AUDIENCE,
  TEST_ISSUER,
  TEST_TOKEN_SECRET,
  type TestHarness,
} from './helpers/doubles';

/**
 * 作家さまへの精算（`UD-119`。決定 2026-08-20）。
 *
 * ⚠️ **この組の主題は 5 つ。**
 *  1. 締めを迎えていない期間を締めさせないこと
 *  2. **返金の窓が閉じるまで確定させないこと**（`SETTLEMENT_AND_REFUND.md` §2-3）
 *  3. 確定したあとに金額が動かないこと
 *  4. **「振り込んだ」の記録がオーナー限定＋再認証であること**——実際に
 *     振り込んだかを機械は確かめられない
 *  5. 金額を書き換える口がそもそも無いこと
 */

let app: INestApplication;
let harness: TestHarness;

/** 9 月半ば。8 月は締めを迎えており、8/10 の注文の窓（14 日）は閉じている。 */
const NOW = new Date('2026-09-20T00:00:00.000Z');
const PERIOD = '2026-08';
const CREATOR = 'account-creator-1';

function tokenFor(subject: string, issuedSecondsAgo = 0): string {
  const nowSeconds = Math.floor(NOW.getTime() / 1000);
  return createDevToken(TEST_TOKEN_SECRET, {
    sub: subject,
    iss: TEST_ISSUER,
    aud: TEST_AUDIENCE,
    iat: nowSeconds - issuedSecondsAgo,
    exp: nowSeconds + 3600,
  });
}

function actorToken(
  role: Role,
  subject: string,
  options: { isOwner?: boolean; issuedSecondsAgo?: number } = {},
): string {
  harness.accounts.seed(subject, role, { isOwner: options.isOwner ?? false });
  return tokenFor(subject, options.issuedSecondsAgo ?? 0);
}

function auth(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

function ownerToken(): string {
  return actorToken('operator', 'owner-1', { isOwner: true });
}

function candidate(overrides: Partial<PayoutCandidate> = {}): PayoutCandidate {
  return {
    orderId: `order-${Math.abs(hash(JSON.stringify(overrides)))}`,
    orderNumber: 'SNK-0001',
    creatorAccountId: CREATOR,
    artworkTitleSnapshot: '天下布武の陣羽織',
    paidAt: new Date('2026-08-10T00:00:00.000Z'),
    grossAmount: 12000,
    feeRateBps: 2000,
    feeAmount: 2400,
    netAmount: 9600,
    // 8/10 + 14 日 = 8/24。⚠️ `NOW`（9/20）より前なので閉じている。
    refundableUntil: new Date('2026-08-24T00:00:00.000Z'),
    ...overrides,
  };
}

/** ⚠️ 試験の中で乱数を使わない。同じ入力で同じ ID になるようにする。 */
function hash(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) {
    h = (Math.imul(h, 31) + value.charCodeAt(i)) | 0;
  }
  return h;
}

function closePeriod(token: string, periodKey = PERIOD) {
  return request(app.getHttpServer())
    .post('/api/v1/admin/payouts/close')
    .set(auth(token))
    .send({ periodKey });
}

beforeEach(async () => {
  harness = buildHarness(
    new DevTokenVerifier({
      secret: TEST_TOKEN_SECRET,
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
      now: () => NOW,
    }),
  );
  harness.clock.set(NOW);
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.register(harness)],
  }).compile();
  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new DomainErrorFilter());
  await app.init();
});

afterEach(async () => {
  await app.close();
});

describe('誰が触れるか', () => {
  it('未認証では一覧を見られない', async () => {
    await request(app.getHttpServer()).get('/api/v1/admin/payouts').expect(401);
  });

  it('会員は一覧を見られない', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/payouts')
      .set(auth(actorToken('buyer', 'buyer-1')))
      .expect(403);
  });

  it('監査担当は一覧を見られる（いくら誰へ払ったかが見えないと監査にならない）', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/payouts')
      .set(auth(actorToken('auditor', 'auditor-1')))
      .expect(200);
  });

  it('監査担当は締められない', async () => {
    await closePeriod(actorToken('auditor', 'auditor-2')).expect(403);
  });

  it('運営は締められる（オーナーの印を要らない）', async () => {
    await closePeriod(actorToken('operator', 'operator-1')).expect(201);
  });
});

describe('締め', () => {
  it('締めを迎えていない期間は締められない', async () => {
    /*
      ⚠️ **まだ売れる余地のある期間を締めると、その日の売上が漏れる。**
         9 月はまだ終わっていない（いまは 9/20）。
    */
    const response = await closePeriod(actorToken('operator', 'operator-3'), '2026-09').expect(409);
    expect(response.body.error.code).toBe('PAYOUT_PERIOD_NOT_CLOSED');
  });

  it('締め月の形が違えば断る', async () => {
    await closePeriod(actorToken('operator', 'operator-4'), '2026-8').expect(400);
  });

  it('取り決めが未設定なら締めない（既定値を作らない）', async () => {
    /*
      ⚠️ **最低支払額も振込手数料の負担も、決めていないまま焼き付けない。**
         焼き付けた値はもう直せない。
    */
    harness.settlement.clear();
    const response = await closePeriod(actorToken('operator', 'operator-5')).expect(400);
    expect(response.body.error.code).toBe('SETTLEMENT_SETTINGS_INVALID');
  });

  it('売上のある作家さまごとに下書きを作る', async () => {
    harness.payouts.candidates = [
      candidate({ orderId: 'order-1' }),
      candidate({ orderId: 'order-2' }),
      candidate({ orderId: 'order-3', creatorAccountId: 'account-creator-2' }),
    ];

    const response = await closePeriod(actorToken('operator', 'operator-6')).expect(201);
    expect(response.body.items).toHaveLength(2);

    const mine = response.body.items.find(
      (row: { creatorAccountId: string }) => row.creatorAccountId === CREATOR,
    );
    expect(mine).toMatchObject({
      periodKey: PERIOD,
      status: 'draft',
      grossAmount: 24000,
      feeAmount: 4800,
      netAmount: 19200,
      lineCount: 2,
    });
  });

  it('締め期間と期日を焼き付ける（JST の月境界・翌月末）', async () => {
    harness.payouts.candidates = [candidate({ orderId: 'order-1' })];
    const response = await closePeriod(actorToken('operator', 'operator-7')).expect(201);

    expect(response.body.items[0]).toMatchObject({
      // JST 8/1 0 時 = UTC 7/31 15 時。
      periodStart: '2026-07-31T15:00:00.000Z',
      periodEnd: '2026-08-31T15:00:00.000Z',
      // 翌月末（JST 9/30 23:59:59.999）。
      dueAt: '2026-09-30T14:59:59.999Z',
      minimumPayoutAmount: 1000,
      transferFeeBearer: 'creator',
    });
  });

  it('何度押しても、下書きは 1 件のまま', async () => {
    harness.payouts.candidates = [candidate({ orderId: 'order-1' })];
    const operator = actorToken('operator', 'operator-8');
    await closePeriod(operator).expect(201);
    await closePeriod(operator).expect(201);

    const listed = await request(app.getHttpServer())
      .get(`/api/v1/admin/payouts?periodKey=${PERIOD}`)
      .set(auth(operator))
      .expect(200);
    expect(listed.body.items).toHaveLength(1);
  });

  it('確定済みの精算は作り直さない', async () => {
    harness.payouts.candidates = [candidate({ orderId: 'order-1' })];
    const operator = actorToken('operator', 'operator-9');
    const first = await closePeriod(operator).expect(201);
    const payoutId = first.body.items[0].id as string;

    await request(app.getHttpServer())
      .post(`/api/v1/admin/payouts/${payoutId}/confirm`)
      .set(auth(operator))
      .expect(200);

    // ⚠️ 例外にしない。1 人でも確定済みだと期間ごと締め直せなくなる。
    await closePeriod(operator).expect(201);

    const after = await request(app.getHttpServer())
      .get(`/api/v1/admin/payouts/${payoutId}`)
      .set(auth(operator))
      .expect(200);
    expect(after.body.payout.status).toBe('confirmed');
    expect(after.body.payout.netAmount).toBe(9600);
  });

  it('同じ注文を 2 つの精算に載せない', async () => {
    harness.payouts.candidates = [candidate({ orderId: 'order-1' })];
    const operator = actorToken('operator', 'operator-10');
    const first = await closePeriod(operator).expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/admin/payouts/${first.body.items[0].id as string}/confirm`)
      .set(auth(operator))
      .expect(200);

    /*
      ⚠️ **二重払いを防ぐ要。** すでにどこかの精算に載っている注文は、
         次の期間の候補から外れる。
    */
    const candidates = await harness.payouts.listCandidates({
      creatorAccountId: CREATOR,
      periodStart: new Date('2026-07-31T15:00:00.000Z'),
      periodEnd: new Date('2026-08-31T15:00:00.000Z'),
    });
    expect(candidates).toHaveLength(0);
  });
});

describe('確定', () => {
  async function draftPayout(operator: string): Promise<string> {
    const response = await closePeriod(operator).expect(201);
    return response.body.items[0].id as string;
  }

  it('返金の窓が開いていれば確定できない', async () => {
    /*
      ⚠️ **閉じる前に確定すると、返金のたびに作家さまから返してもらう話に
         なる。** いちばん揉める作業で、少額なら回収を諦めることになり、
         諦めた分は運営の損になる。
    */
    harness.payouts.candidates = [
      candidate({ orderId: 'order-1', refundableUntil: new Date('2026-09-25T00:00:00.000Z') }),
    ];
    const operator = actorToken('operator', 'operator-11');
    const payoutId = await draftPayout(operator);

    const response = await request(app.getHttpServer())
      .post(`/api/v1/admin/payouts/${payoutId}/confirm`)
      .set(auth(operator))
      .expect(409);
    expect(response.body.error.code).toBe('PAYOUT_WINDOW_OPEN');
  });

  it('期限が付いていない注文でも確定できない', async () => {
    // ⚠️ 分からないものを、分かったことにしない。
    harness.payouts.candidates = [candidate({ orderId: 'order-1', refundableUntil: null })];
    const operator = actorToken('operator', 'operator-12');
    const payoutId = await draftPayout(operator);

    await request(app.getHttpServer())
      .post(`/api/v1/admin/payouts/${payoutId}/confirm`)
      .set(auth(operator))
      .expect(409);
  });

  it('すべて閉じていれば確定できる', async () => {
    harness.payouts.candidates = [candidate({ orderId: 'order-1' })];
    const operator = actorToken('operator', 'operator-13');
    const payoutId = await draftPayout(operator);

    const response = await request(app.getHttpServer())
      .post(`/api/v1/admin/payouts/${payoutId}/confirm`)
      .set(auth(operator))
      .expect(200);
    expect(response.body.status).toBe('confirmed');
    expect(response.body.confirmedAt).not.toBeNull();
  });

  it('二度目は断る（同時に押されても 1 回）', async () => {
    harness.payouts.candidates = [candidate({ orderId: 'order-1' })];
    const operator = actorToken('operator', 'operator-14');
    const payoutId = await draftPayout(operator);

    await request(app.getHttpServer())
      .post(`/api/v1/admin/payouts/${payoutId}/confirm`)
      .set(auth(operator))
      .expect(200);
    const second = await request(app.getHttpServer())
      .post(`/api/v1/admin/payouts/${payoutId}/confirm`)
      .set(auth(operator))
      .expect(409);
    expect(second.body.error.code).toBe('PAYOUT_NOT_EDITABLE');
  });

  it('監査ログに残す', async () => {
    harness.payouts.candidates = [candidate({ orderId: 'order-1' })];
    const operator = actorToken('operator', 'operator-15');
    const payoutId = await draftPayout(operator);
    await request(app.getHttpServer())
      .post(`/api/v1/admin/payouts/${payoutId}/confirm`)
      .set(auth(operator))
      .expect(200);

    const entry = harness.audit.entries.find((row) => row.action === 'payout.confirmed');
    expect(entry?.summary).toMatchObject({ periodKey: PERIOD, netAmount: 9600 });
  });
});

describe('支払い済みにする', () => {
  async function confirmedPayout(operator: string): Promise<string> {
    harness.payouts.candidates = [candidate({ orderId: 'order-1' })];
    const created = await closePeriod(operator).expect(201);
    const payoutId = created.body.items[0].id as string;
    await request(app.getHttpServer())
      .post(`/api/v1/admin/payouts/${payoutId}/confirm`)
      .set(auth(operator))
      .expect(200);
    return payoutId;
  }

  it('オーナーの印が無い運営はできない', async () => {
    /*
      ⚠️ **これは「振り込んだ」という宣言であって、振込そのものではない。**
         実際に振り込んだかを機械は確かめられないので、記録だけ進めれば
         「支払い済みなのに入金が無い」を作れてしまう。
    */
    const operator = actorToken('operator', 'operator-16');
    const payoutId = await confirmedPayout(operator);
    await request(app.getHttpServer())
      .post(`/api/v1/admin/payouts/${payoutId}/mark-paid`)
      .set(auth(operator))
      .expect(403);
  });

  it('オーナーでも、ログインから時間が経っていれば断る', async () => {
    const operator = actorToken('operator', 'operator-17');
    const payoutId = await confirmedPayout(operator);
    const stale = actorToken('operator', 'owner-old', {
      isOwner: true,
      issuedSecondsAgo: 3600,
    });
    // ⚠️ 401。ログインし直せば通ることが伝わる符号にする。
    await request(app.getHttpServer())
      .post(`/api/v1/admin/payouts/${payoutId}/mark-paid`)
      .set(auth(stale))
      .expect(401);
  });

  it('オーナーが最近ログインしていれば通る。誰が宣言したかを残す', async () => {
    const operator = actorToken('operator', 'operator-18');
    const payoutId = await confirmedPayout(operator);

    const response = await request(app.getHttpServer())
      .post(`/api/v1/admin/payouts/${payoutId}/mark-paid`)
      .set(auth(ownerToken()))
      .expect(200);

    expect(response.body).toMatchObject({ status: 'paid', paidByAccountId: 'account-owner-1' });
    expect(response.body.paidAt).not.toBeNull();
  });

  it('確定していない精算は支払い済みにできない', async () => {
    harness.payouts.candidates = [candidate({ orderId: 'order-1' })];
    const created = await closePeriod(actorToken('operator', 'operator-19')).expect(201);

    const response = await request(app.getHttpServer())
      .post(`/api/v1/admin/payouts/${created.body.items[0].id as string}/mark-paid`)
      .set(auth(ownerToken()))
      .expect(409);
    expect(response.body.error.code).toBe('PAYOUT_NOT_EDITABLE');
  });
});

describe('明細', () => {
  it('注文ごとに 1 行、注文時点の作品名で出す', async () => {
    // ⚠️ マスタを引き直さない。改名しても過去の明細は変わらない。
    harness.payouts.candidates = [
      candidate({ orderId: 'order-1', artworkTitleSnapshot: '当時の名前' }),
    ];
    const operator = actorToken('operator', 'operator-20');
    const created = await closePeriod(operator).expect(201);

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/admin/payouts/${created.body.items[0].id as string}`)
      .set(auth(operator))
      .expect(200);

    expect(detail.body.lines).toHaveLength(1);
    expect(detail.body.lines[0]).toMatchObject({
      orderId: 'order-1',
      artworkTitleSnapshot: '当時の名前',
      netAmount: 9600,
      isClawback: false,
    });
  });

  it('返金の窓が開いている件数を返す（画面が先に伝えられるように）', async () => {
    harness.payouts.candidates = [
      candidate({ orderId: 'order-1', refundableUntil: new Date('2026-09-25T00:00:00.000Z') }),
    ];
    const operator = actorToken('operator', 'operator-21');
    const created = await closePeriod(operator).expect(201);

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/admin/payouts/${created.body.items[0].id as string}`)
      .set(auth(operator))
      .expect(200);
    expect(detail.body.openRefundWindows).toBe(1);
  });

  it('無い精算は 404', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/payouts/00000000-0000-4000-8000-000000000000')
      .set(auth(actorToken('operator', 'operator-22')))
      .expect(404);
  });
});

describe('金額を書き換える口が無い', () => {
  /*
    ⚠️ **禁止事項**（`SETTLEMENT_AND_REFUND.md` §4）。訂正は次の期間での
       調整として行う。直接書き換えを許すと、明細と振込額が食い違ったときに、
       どちらが正しいのか誰にも分からなくなる。
  */
  it('金額を送っても無視される（受け取る欄が無い）', async () => {
    harness.payouts.candidates = [candidate({ orderId: 'order-1' })];
    const operator = actorToken('operator', 'operator-23');
    const response = await request(app.getHttpServer())
      .post('/api/v1/admin/payouts/close')
      .set(auth(operator))
      .send({ periodKey: PERIOD, netAmount: 1 })
      .expect(201);
    expect(response.body.items[0].netAmount).toBe(9600);
  });

  it('精算を消す口が無い', async () => {
    harness.payouts.candidates = [candidate({ orderId: 'order-1' })];
    const operator = actorToken('operator', 'operator-24');
    const created = await closePeriod(operator).expect(201);
    await request(app.getHttpServer())
      .delete(`/api/v1/admin/payouts/${created.body.items[0].id as string}`)
      .set(auth(operator))
      .expect(404);
  });
});
