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
  FakePayoutAccountCipher,
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
    isUnderDispute: false,
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

  it('決着していないチャージバックがあれば確定できない', async () => {
    /*
      ⚠️ **争いの最中にお支払いすると、負けたときに作家さまから返して
         もらう話になる。** 返金の窓と同じ性質の歯止めだが、こちらは
         **期限では閉じない**——カード会社が決めるまで開いたまま。
    */
    harness.payouts.candidates = [candidate({ orderId: 'order-1' })];
    harness.payouts.disputedOrderIds.add('order-1');
    const operator = actorToken('operator', 'operator-15');
    const payoutId = await draftPayout(operator);

    const response = await request(app.getHttpServer())
      .post(`/api/v1/admin/payouts/${payoutId}/confirm`)
      .set(auth(operator))
      .expect(409);
    /*
      ⚠️ **返金の窓とは別の符号。** 一緒にすると、運営が「期限を待てば
         開く」と読む。争いは待っても開かない。
    */
    expect(response.body.error.code).toBe('PAYOUT_DISPUTE_OPEN');
  });

  it('争いが決着していれば確定できる', async () => {
    // ⚠️ 決着した争いは歯止めにならない。止め続けると、いつまでも払えない。
    harness.payouts.candidates = [candidate({ orderId: 'order-1' })];
    const operator = actorToken('operator', 'operator-16');
    const payoutId = await draftPayout(operator);

    await request(app.getHttpServer())
      .post(`/api/v1/admin/payouts/${payoutId}/confirm`)
      .set(auth(operator))
      .expect(200);
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

/**
 * 振込のために、お振込先を読む（決定 2026-08-21）。
 *
 * ⚠️ **この組の主題は 5 つ。**
 *  1. **`payout.view` では読めない**こと（監査担当にも渡していない）
 *  2. **確定するまで開かない**こと——読む口を「振り込むため」に絞る
 *  3. **監査ログに値が残らない**こと——残せば包んだ意味が失われる
 *  4. **明細（`detail`）に値が載らない**こと——開いただけで流れない
 *  5. **解けなかったら伏せた表記で代用しない**こと——振り込ませない
 */
describe('お振込先を運営が読む', () => {
  const NUMBER = '1234567';

  /** ⚠️ 本物と同じ包み方をする。代役でも結び付け先は必ずアカウントID。 */
  function seedAccount(creatorAccountId = CREATOR, sealedFor = creatorAccountId): void {
    harness.payoutAccounts.rows.set(creatorAccountId, {
      creatorAccountId,
      bankName: '千ノ国銀行',
      branchName: '本店',
      accountType: 'ordinary',
      sealedAccountNumber: new FakePayoutAccountCipher().seal(NUMBER, sealedFor),
      maskedAccountNumber: '***4567',
      accountHolderKana: 'センノクニ　タロウ',
      updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    });
  }

  /** 確定済みの精算を 1 件つくる。⚠️ 読めるのは確定してから。 */
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

  function readAccount(token: string, payoutId: string) {
    return request(app.getHttpServer())
      .get(`/api/v1/admin/payouts/${payoutId}/payout-account`)
      .set(auth(token));
  }

  it('監査担当は読めない（読んだことを確かめる側である）', async () => {
    seedAccount();
    const operator = actorToken('operator', 'operator-account-1');
    const payoutId = await confirmedPayout(operator);

    await readAccount(actorToken('auditor', 'auditor-account-1'), payoutId).expect(403);
    // ⚠️ **同じ要求が運営なら通ることを確かめる。** 確かめないと、
    //    経路そのものが壊れていても 403 になり、この試験が空振りする。
    await readAccount(operator, payoutId).expect(200);
  });

  it('会員は読めない', async () => {
    seedAccount();
    const operator = actorToken('operator', 'operator-account-2');
    const payoutId = await confirmedPayout(operator);
    await readAccount(actorToken('buyer', 'buyer-account-1'), payoutId).expect(403);
  });

  it('確定するまで開かない（下書きのうちに読む理由が無い）', async () => {
    seedAccount();
    const operator = actorToken('operator', 'operator-account-3');
    harness.payouts.candidates = [candidate({ orderId: 'order-1' })];
    const created = await closePeriod(operator).expect(201);
    const payoutId = created.body.items[0].id as string;

    const response = await readAccount(operator, payoutId).expect(200);
    expect(response.body.status).toBe('not_payable_yet');
    // ⚠️ 状態だけで、値は 1 つも返らない。
    expect(JSON.stringify(response.body)).not.toContain(NUMBER);
  });

  it('確定していれば、運営は伏せずに読める', async () => {
    seedAccount();
    const operator = actorToken('operator', 'operator-account-4');
    const payoutId = await confirmedPayout(operator);

    const response = await readAccount(operator, payoutId).expect(200);
    expect(response.body).toMatchObject({
      status: 'resolved',
      account: {
        bankName: '千ノ国銀行',
        branchName: '本店',
        accountType: 'ordinary',
        // ⚠️ **ここが伏せていないこと。** 伏せたままでは振り込めない。
        accountNumber: NUMBER,
        accountHolderKana: 'センノクニ　タロウ',
      },
    });
  });

  it('未登録なら missing（待っても変わらない）', async () => {
    const operator = actorToken('operator', 'operator-account-5');
    const payoutId = await confirmedPayout(operator);

    const response = await readAccount(operator, payoutId).expect(200);
    expect(response.body.status).toBe('missing');
  });

  it('包みが解けなければ undecipherable。伏せた表記で代用しない', async () => {
    /*
      ⚠️ **別の作家さまの行へ貼り替えられた状態を作る。** 鍵の入れ替えを
         誤った場合も同じ結果になる。**どちらでも振り込んではいけない**ので、
         「***4567 までは分かる」と出さないことを確かめる。
    */
    seedAccount(CREATOR, 'account-someone-else');
    const operator = actorToken('operator', 'operator-account-6');
    const payoutId = await confirmedPayout(operator);

    const response = await readAccount(operator, payoutId).expect(200);
    expect(response.body.status).toBe('undecipherable');
    expect(JSON.stringify(response.body)).not.toContain('4567');
  });

  it('預かる仕組みが無い配備では not_configured', async () => {
    const operator = actorToken('operator', 'operator-account-7');
    const payoutId = await confirmedPayout(operator);

    // ⚠️ 暗号鍵を設定していない配備の姿。**起動はする。**
    const { payoutAccounts: _omitted, ...creatorOperations } = harness.creatorOperations;
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register({ ...harness, creatorOperations })],
    }).compile();
    const bare = moduleRef.createNestApplication();
    bare.useGlobalFilters(new DomainErrorFilter());
    await bare.init();
    try {
      const response = await request(bare.getHttpServer())
        .get(`/api/v1/admin/payouts/${payoutId}/payout-account`)
        .set(auth(operator))
        .expect(200);
      expect(response.body.status).toBe('not_configured');
    } finally {
      await bare.close();
    }
  });

  it('読むたびに記録が残る。⚠️ 値は残らない', async () => {
    seedAccount();
    const operator = actorToken('operator', 'operator-account-8');
    const payoutId = await confirmedPayout(operator);
    await readAccount(operator, payoutId).expect(200);

    const entries = harness.audit.entries.filter((row) => row.action === 'payout_account.viewed');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actorAccountId: 'account-operator-account-8',
      targetType: 'payout',
      targetId: payoutId,
    });
    /*
      ⚠️ **記録のどこにも口座の値が無いこと。** 入った瞬間、包んで保管した
         意味が監査ログの側から失われる。名義も伏せた表記も残さない。
    */
    const recorded = JSON.stringify(entries[0]);
    expect(recorded).not.toContain(NUMBER);
    expect(recorded).not.toContain('4567');
    expect(recorded).not.toContain('センノクニ');
    expect(recorded).not.toContain('千ノ国銀行');
  });

  it('2 回読めば 2 行残る（同じ人でもまとめない）', async () => {
    seedAccount();
    const operator = actorToken('operator', 'operator-account-9');
    const payoutId = await confirmedPayout(operator);
    await readAccount(operator, payoutId).expect(200);
    await readAccount(operator, payoutId).expect(200);

    expect(
      harness.audit.entries.filter((row) => row.action === 'payout_account.viewed'),
    ).toHaveLength(2);
  });

  it('読めなかったときも記録が残る（開こうとしたこと自体が対象）', async () => {
    const operator = actorToken('operator', 'operator-account-10');
    const payoutId = await confirmedPayout(operator);
    await readAccount(operator, payoutId).expect(200);

    const entry = harness.audit.entries.find((row) => row.action === 'payout_account.viewed');
    expect(entry?.summary).toMatchObject({ result: 'missing' });
  });

  it('明細には状態だけが載り、値は載らない', async () => {
    seedAccount();
    const operator = actorToken('operator', 'operator-account-11');
    const payoutId = await confirmedPayout(operator);

    const response = await request(app.getHttpServer())
      .get(`/api/v1/admin/payouts/${payoutId}`)
      .set(auth(operator))
      .expect(200);

    expect(response.body.payoutAccountStatus).toBe('registered');
    const body = JSON.stringify(response.body);
    expect(body).not.toContain(NUMBER);
    expect(body).not.toContain('4567');
    expect(body).not.toContain('千ノ国銀行');
    // ⚠️ 明細を開いただけでは、記録に「読んだ」と残らない。
    expect(harness.audit.entries.filter((row) => row.action === 'payout_account.viewed')).toEqual(
      [],
    );
  });

  it('未登録なら、明細の状態が missing になる（確定の前に気づける）', async () => {
    const operator = actorToken('operator', 'operator-account-12');
    harness.payouts.candidates = [candidate({ orderId: 'order-1' })];
    const created = await closePeriod(operator).expect(201);

    const response = await request(app.getHttpServer())
      .get(`/api/v1/admin/payouts/${created.body.items[0].id as string}`)
      .set(auth(operator))
      .expect(200);
    expect(response.body.payoutAccountStatus).toBe('missing');
  });

  it('監査担当も明細の状態は見られる（振込先が無いまま確定していないか）', async () => {
    seedAccount();
    const operator = actorToken('operator', 'operator-account-13');
    const payoutId = await confirmedPayout(operator);

    const response = await request(app.getHttpServer())
      .get(`/api/v1/admin/payouts/${payoutId}`)
      .set(auth(actorToken('auditor', 'auditor-account-2')))
      .expect(200);
    expect(response.body.payoutAccountStatus).toBe('registered');
  });
});
