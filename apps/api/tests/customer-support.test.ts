import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createDevToken, DevTokenVerifier } from '@sengoku/integrations';
import type { Role } from '@sengoku/auth';
import { AppModule } from '../src/app.module';
import { DomainErrorFilter } from '../src/common/domain-error.filter';
import {
  buildHarness,
  TEST_AUDIENCE,
  TEST_ISSUER,
  TEST_NOW,
  TEST_TOKEN_SECRET,
  type TestHarness,
} from './helpers/doubles';

/**
 * 顧客サポート（実運営 指示書 P1-1）。
 *
 * ⚠️ **この組の主題は 4 つ。**
 *  1. **付け替えの口が存在しないこと**（指示書 §11 の明示的な禁止）
 *  2. **応答に氏名・メールアドレスの平文が出ないこと**（`UD-503`）
 *  3. **本人確認を飛ばして「済」にできないこと**
 *  4. **条件無しで顧客を一覧できないこと**
 */

let app: INestApplication;
let harness: TestHarness;

const ACCOUNT_ID = 'aa11bb22-0000-4000-8000-000000000001';
const OTHER_ID = 'aa11bb22-0000-4000-8000-000000000002';
const EMAIL = 'buyer@example.test';

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

/** 買った方を 1 人置く。⚠️ 平文のアドレスは代替実装にも持たせない。 */
function seedCustomer(overrides: Record<string, unknown> = {}): void {
  harness.customerDirectory.summaries = [
    {
      accountId: ACCOUNT_ID,
      maskedEmail: null,
      commonUserId: 'cu_0123456789abcdef0123456789abcdef',
      status: 'active',
      orderCount: 2,
      paidAmount: 24_000,
      refundedAmount: 12_000,
      entitlementCount: 2,
      unclaimedCount: 1,
      firstOrderAt: TEST_NOW,
      lastOrderAt: TEST_NOW,
      ...overrides,
    },
  ];
  harness.customerDirectory.orderRows = [
    {
      accountId: ACCOUNT_ID,
      id: 'order-1',
      orderNumber: 'SNK-20260821-0001',
      status: 'paid',
      paymentStatus: 'succeeded',
      refundStatus: 'none',
      totalAmount: 12_000,
      createdAt: TEST_NOW,
      paidAt: TEST_NOW,
    },
  ];
  const hash = harness.emailHasher.hash(EMAIL);
  if (hash !== null) {
    harness.customerDirectory.byEmailHash.set(hash, [ACCOUNT_ID]);
  }
}

beforeEach(async () => {
  harness = buildHarness(
    new DevTokenVerifier({
      secret: TEST_TOKEN_SECRET,
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
      now: () => TEST_NOW,
    }),
  );
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.register(harness)],
  }).compile();
  app = moduleRef.createNestApplication({ rawBody: true });
  app.useGlobalFilters(new DomainErrorFilter());
  await app.init();
});

afterEach(async () => {
  await app.close();
});

describe('誰が見られるか', () => {
  it('未認証では見られない', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/admin/customers/search')
      .send({ accountId: ACCOUNT_ID })
      .expect(401);
  });

  it('会員は見られない', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/admin/customers/search')
      .set(auth(actorToken('buyer')))
      .send({ accountId: ACCOUNT_ID })
      .expect(403);
  });

  /*
    ⚠️ **監査役へ渡していない。** 監査は「運営が何をしたか」を見る仕事で、
       「その方が何を買ったか」を 1 画面で見る必要は無い。
  */
  it('監査担当は見られない', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/admin/customers/search')
      .set(auth(actorToken('auditor')))
      .send({ accountId: ACCOUNT_ID })
      .expect(403);
  });

  it('運営は見られる', async () => {
    seedCustomer();
    const response = await request(app.getHttpServer())
      .post('/api/v1/admin/customers/search')
      .set(auth(actorToken('operator')))
      .send({ accountId: ACCOUNT_ID })
      .expect(201);
    expect(response.body.items).toHaveLength(1);
  });
});

describe('探し方', () => {
  /*
    ⚠️ **条件無しの全件表示を作らない。** 顧客をただ眺められる画面は
       業務に要らないうえに、漏れたときの被害がいちばん大きい。
  */
  it('手がかり無しでは断る', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/admin/customers/search')
      .set(auth(actorToken('operator')))
      .send({})
      .expect(400);
  });

  it('注文番号から辿れる', async () => {
    seedCustomer();
    const response = await request(app.getHttpServer())
      .post('/api/v1/admin/customers/search')
      .set(auth(actorToken('operator')))
      .send({ orderNumber: 'SNK-20260821-0001' })
      .expect(201);
    expect(response.body.items[0].accountId).toBe(ACCOUNT_ID);
  });

  it('メールアドレスから辿れる', async () => {
    seedCustomer();
    const response = await request(app.getHttpServer())
      .post('/api/v1/admin/customers/search')
      .set(auth(actorToken('operator')))
      .send({ email: EMAIL })
      .expect(201);
    expect(response.body.items[0].accountId).toBe(ACCOUNT_ID);
  });

  /*
    ⚠️ **引いた値そのものを記録に残さない。** 記録に平文が残れば、
       `UD-503` を監査ログの側から破ることになる。
  */
  it('検索は記録に残るが、引いた値は残らない', async () => {
    seedCustomer();
    await request(app.getHttpServer())
      .post('/api/v1/admin/customers/search')
      .set(auth(actorToken('operator')))
      .send({ email: EMAIL })
      .expect(201);

    const recorded = harness.audit.entries.filter((row) => row.action === 'customer.search');
    expect(recorded).toHaveLength(1);
    expect(JSON.stringify(recorded[0])).not.toContain(EMAIL);
    expect(recorded[0]?.summary).toMatchObject({ by: 'email' });
  });
});

describe('顧客の詳細', () => {
  it('応答に氏名もメールアドレスも出ない', async () => {
    seedCustomer();
    const response = await request(app.getHttpServer())
      .get(`/api/v1/admin/customers/${ACCOUNT_ID}`)
      .set(auth(actorToken('operator')))
      .expect(200);

    const body = JSON.stringify(response.body);
    expect(body).not.toContain(EMAIL);
    expect(body).not.toMatch(/@/);
  });

  /*
    ⚠️ **画面で引き算をさせない。** 応対中の暗算は間違う。
  */
  it('差し引き後の手取りをサーバー側で出す', async () => {
    seedCustomer();
    const response = await request(app.getHttpServer())
      .get(`/api/v1/admin/customers/${ACCOUNT_ID}`)
      .set(auth(actorToken('operator')))
      .expect(200);
    expect(response.body.summary.netPaidAmount).toBe(12_000);
  });

  it('応対の前に知っておくべきことが出る', async () => {
    seedCustomer();
    const response = await request(app.getHttpServer())
      .get(`/api/v1/admin/customers/${ACCOUNT_ID}`)
      .set(auth(actorToken('operator')))
      .expect(200);
    expect(response.body.attentions.map((row: { key: string }) => row.key)).toContain(
      'unclaimed_entitlements',
    );
  });

  /*
    ⚠️ **代理店・紹介元は、まだ持っていない。** 連携（M0〜M4）が契約待ちで、
       注文に紹介元を残す列が無い。埋まっているふりをしない。
  */
  it('代理店・紹介元は「無い」と明示して返る', async () => {
    seedCustomer();
    const response = await request(app.getHttpServer())
      .get(`/api/v1/admin/customers/${ACCOUNT_ID}`)
      .set(auth(actorToken('operator')))
      .expect(200);
    expect(response.body).toHaveProperty('referralSnapshot');
    expect(response.body.referralSnapshot).toBeNull();
  });

  it('無い顧客は 404', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/admin/customers/${OTHER_ID}`)
      .set(auth(actorToken('operator')))
      .expect(404);
  });
});

describe('申し送り', () => {
  it('書けて、詳細に出る', async () => {
    seedCustomer();
    await request(app.getHttpServer())
      .post(`/api/v1/admin/customers/${ACCOUNT_ID}/notes`)
      .set(auth(actorToken('operator')))
      .send({ body: '別のアカウントでも購入されている可能性があります。' })
      .expect(201);

    const response = await request(app.getHttpServer())
      .get(`/api/v1/admin/customers/${ACCOUNT_ID}`)
      .set(auth(actorToken('operator')))
      .expect(200);
    expect(response.body.notes).toHaveLength(1);
  });

  /*
    ⚠️ **本文を監査ログへ写さない。** メモには問い合わせの内容が入る。
       2 か所に増やすと、消せない場所が 2 つになる。
  */
  it('本文は監査ログへ写らない', async () => {
    seedCustomer();
    const body = 'ご家族の代理でご連絡いただいています。';
    await request(app.getHttpServer())
      .post(`/api/v1/admin/customers/${ACCOUNT_ID}/notes`)
      .set(auth(actorToken('operator')))
      .send({ body })
      .expect(201);

    const recorded = harness.audit.entries.filter((row) => row.action === 'customer.note');
    expect(recorded).toHaveLength(1);
    expect(JSON.stringify(recorded[0])).not.toContain(body);
  });

  it('空のメモは断る', async () => {
    seedCustomer();
    await request(app.getHttpServer())
      .post(`/api/v1/admin/customers/${ACCOUNT_ID}/notes`)
      .set(auth(actorToken('operator')))
      .send({ body: '' })
      .expect(400);
  });
});

describe('ご連絡先の変更申請', () => {
  async function open(): Promise<string> {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/admin/customers/${ACCOUNT_ID}/email-changes`)
      .set(auth(actorToken('operator')))
      .send({ newEmail: 'new-address@example.test' })
      .expect(201);
    return response.body.id;
  }

  /*
    ⚠️ **新しいアドレスの平文を保存しない。** 伏せた表記と照合値まで。
  */
  it('新しいアドレスの平文を保存しない', async () => {
    seedCustomer();
    await open();
    const row = harness.emailChangeRequests.rows[0];
    expect(row?.requestedMaskedEmail).toContain('*');
    expect(JSON.stringify(harness.emailChangeRequests.rows)).not.toContain(
      'new-address@example.test',
    );
  });

  /*
    ⚠️ **この試験がこの仕組みの存在理由。** 飛ばされたことは、
       乗っ取られるまで誰にも分からない。
  */
  it('本人確認を飛ばして「済」にできない', async () => {
    seedCustomer();
    const id = await open();
    await request(app.getHttpServer())
      .post(`/api/v1/admin/customers/email-changes/${id}/settle`)
      .set(auth(actorToken('operator')))
      .send({ status: 'completed', note: null })
      .expect(409);
  });

  it('本人確認を経れば「済」にできる', async () => {
    seedCustomer();
    const id = await open();
    await request(app.getHttpServer())
      .post(`/api/v1/admin/customers/email-changes/${id}/verify`)
      .set(auth(actorToken('operator')))
      .send({ method: 'order_details_match', note: 'ご注文番号と金額が一致しました。' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/admin/customers/email-changes/${id}/settle`)
      .set(auth(actorToken('operator')))
      .send({ status: 'completed', note: null })
      .expect(201);

    expect(harness.emailChangeRequests.rows[0]?.status).toBe('completed');
  });

  it('本人確認は「誰が」が残る', async () => {
    seedCustomer();
    const id = await open();
    await request(app.getHttpServer())
      .post(`/api/v1/admin/customers/email-changes/${id}/verify`)
      .set(auth(actorToken('operator')))
      .send({ method: 'identity_document', note: null })
      .expect(201);

    expect(harness.emailChangeRequests.rows[0]?.verifiedByAccountId).toBeTruthy();
    const recorded = harness.audit.entries.filter(
      (row) => row.action === 'customer.email_change_verified',
    );
    expect(recorded).toHaveLength(1);
  });

  it('理由の無い見送りは断る', async () => {
    seedCustomer();
    const id = await open();
    await request(app.getHttpServer())
      .post(`/api/v1/admin/customers/email-changes/${id}/settle`)
      .set(auth(actorToken('operator')))
      .send({ status: 'rejected', note: null })
      .expect(409);
  });

  it('決着した申請は動かせない', async () => {
    seedCustomer();
    const id = await open();
    await request(app.getHttpServer())
      .post(`/api/v1/admin/customers/email-changes/${id}/settle`)
      .set(auth(actorToken('operator')))
      .send({ status: 'rejected', note: '取り下げのご連絡がありました。' })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/api/v1/admin/customers/email-changes/${id}/verify`)
      .set(auth(actorToken('operator')))
      .send({ method: 'identity_document', note: null })
      .expect(409);
  });

  it('監査担当は本人確認を押せない', async () => {
    seedCustomer();
    const id = await open();
    await request(app.getHttpServer())
      .post(`/api/v1/admin/customers/email-changes/${id}/verify`)
      .set(auth(actorToken('auditor')))
      .send({ method: 'identity_document', note: null })
      .expect(403);
  });
});

describe('禁じた操作の口が無いこと（指示書 §11）', () => {
  /*
    ⚠️ **本人確認をしていない付け替えは、他人の持ち物を渡すことと同じ。**
       いちばん強い権限で叩いて 404 であることを確かめる。403 だと
       「権限さえあれば通る口がある」ことになり、意味が変わってしまう。
  */
  it.each([
    ['注文の持ち主を変える', `/api/v1/admin/customers/${ACCOUNT_ID}/reassign-orders`],
    ['受取権の持ち主を変える', `/api/v1/admin/customers/${ACCOUNT_ID}/reassign-entitlements`],
    ['ウォレットの持ち主を変える', `/api/v1/admin/customers/${ACCOUNT_ID}/reassign-wallet`],
    ['重複アカウントを統合する', `/api/v1/admin/customers/${ACCOUNT_ID}/merge`],
  ])('%s 口は存在しない', async (_label, path) => {
    await request(app.getHttpServer())
      .post(path)
      .set(auth(actorToken('operator')))
      .send({ targetAccountId: OTHER_ID })
      .expect(404);
  });

  /*
    ⚠️ **重複は「候補の表示」まで。** 判断も統合も、人の手による別の手続き。
  */
  it('重複候補は表示されるが、統合の口は無い', async () => {
    seedCustomer();
    harness.customerDirectory.candidates.set(ACCOUNT_ID, [
      {
        accountId: OTHER_ID,
        maskedEmail: null,
        commonUserId: null,
        status: 'active',
        orderCount: 1,
        entitlementCount: 1,
        signals: ['email_hash'],
        createdAt: TEST_NOW,
      },
    ]);

    const response = await request(app.getHttpServer())
      .get(`/api/v1/admin/customers/${ACCOUNT_ID}`)
      .set(auth(actorToken('operator')))
      .expect(200);
    expect(response.body.duplicateCandidates).toHaveLength(1);
    expect(response.body.duplicateCandidates[0].signals).toEqual(['email_hash']);
  });
});

/**
 * ご連絡先そのものを見る（決定 2026-08-21）。
 *
 * ⚠️ **この組の主題は 3 つ。**
 *  1. **保存していないこと**——応答は認証基盤から取り寄せたもので、
 *     こちらの DB には入らない（`UD-503` 維持）
 *  2. **監査ログにアドレスの値が残らないこと**——残せば、監査ログの側から
 *     `UD-503` を破ることになる
 *  3. **`customer.view` では通らないこと**——まとめて見ることと、
 *     連絡先を読むことは別の力
 */
describe('ご連絡先を見る', () => {
  beforeEach(() => {
    seedCustomer();
    harness.customerRecipients.emails.set(ACCOUNT_ID, EMAIL);
  });

  it('運営は取り寄せられる', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/admin/customers/${ACCOUNT_ID}/email`)
      .set(auth(actorToken('operator')))
      .expect(200);
    expect(response.body).toEqual({ status: 'resolved', email: EMAIL });
  });

  it('未認証では取り寄せられない', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/admin/customers/${ACCOUNT_ID}/email`)
      .expect(401);
  });

  /*
    ⚠️ **監査は「読んだことを確かめる側」であって、読む側ではない。**
       読む側と確かめる側が同じ人だと、歯止めにならない。
  */
  it('閲覧者は取り寄せられない', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/admin/customers/${ACCOUNT_ID}/email`)
      .set(auth(actorToken('auditor')))
      .expect(403);
    // ⚠️ 断られたのだから、認証基盤へも問い合わせていない。
    expect(harness.customerRecipients.calls).toEqual([]);
  });

  it('会員は取り寄せられない', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/admin/customers/${ACCOUNT_ID}/email`)
      .set(auth(actorToken('buyer')))
      .expect(403);
  });

  /*
    ⚠️ **顧客詳細には出さない。** 出すと、画面を開いただけで全員のアドレスが
       流れ、監査ログが「開いた人」で埋まって**本当に読んだ人が埋もれる**。
  */
  it('顧客詳細には現れない', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/admin/customers/${ACCOUNT_ID}`)
      .set(auth(actorToken('operator')))
      .expect(200);
    expect(JSON.stringify(response.body)).not.toContain(EMAIL);
    // ⚠️ 詳細を開いただけでは、認証基盤へ問い合わせない。
    expect(harness.customerRecipients.calls).toEqual([]);
  });

  /*
    ⚠️ **この組でいちばん大事な 1 本。** 記録に平文が残れば、
       監査ログの側から `UD-503` を破ることになる。
  */
  it('監査ログにアドレスの値が残らない', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/admin/customers/${ACCOUNT_ID}/email`)
      .set(auth(actorToken('operator')))
      .expect(200);

    const recorded = harness.audit.entries.filter((row) => row.action === 'customer.email.view');
    expect(recorded).toHaveLength(1);
    // ⚠️ 誰の分を見たかは残る。
    expect(recorded[0]?.targetId).toBe(ACCOUNT_ID);
    // ⚠️ **値そのものは、記録のどこにも無い。**
    expect(JSON.stringify(recorded[0])).not.toContain(EMAIL);
    expect(JSON.stringify(recorded[0])).not.toContain('example.test');
  });

  it('取り寄せられなかったときも記録に残る', async () => {
    harness.customerRecipients.down = true;
    const response = await request(app.getHttpServer())
      .get(`/api/v1/admin/customers/${ACCOUNT_ID}/email`)
      .set(auth(actorToken('operator')))
      .expect(200);
    expect(response.body).toEqual({ status: 'unavailable' });

    const recorded = harness.audit.entries.filter((row) => row.action === 'customer.email.view');
    // ⚠️ 失敗も残す。残さないと「試したが取れなかった」を後から確かめられない。
    expect(recorded).toHaveLength(1);
  });

  /*
    ⚠️ **「分からない」と「取れなかった」を分ける。** 前者は待っても
       変わらず、後者は時間をおけば直りうる。同じ値で返すと、応対する人が
       もう一度試すべきかを判断できない。
  */
  it('認証基盤に居ない方は「分からない」で返る（「取れなかった」にしない）', async () => {
    harness.customerRecipients.emails.delete(ACCOUNT_ID);
    const response = await request(app.getHttpServer())
      .get(`/api/v1/admin/customers/${ACCOUNT_ID}/email`)
      .set(auth(actorToken('operator')))
      .expect(200);
    expect(response.body).toEqual({ status: 'unknown' });
  });

  /*
    ⚠️ **居ないアカウントを引けないようにする。** 引けると、この口が
       「そのアカウントが在るか」を確かめる道になる。
  */
  it('居ないアカウントは 404（存否を確かめる道にしない）', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/admin/customers/${OTHER_ID}/email`)
      .set(auth(actorToken('operator')))
      .expect(404);
    expect(harness.customerRecipients.calls).toEqual([]);
  });

  /*
    ⚠️ **保存していないことを、呼ばれた回数で確かめる。** 保存していれば
       2 回目は問い合わせずに返せてしまう。毎回問い合わせているというのが、
       「持っていない」ことの裏返しである。
  */
  it('見るたびに取り寄せる（覚えておかない）', async () => {
    const operator = actorToken('operator');
    await request(app.getHttpServer())
      .get(`/api/v1/admin/customers/${ACCOUNT_ID}/email`)
      .set(auth(operator))
      .expect(200);
    await request(app.getHttpServer())
      .get(`/api/v1/admin/customers/${ACCOUNT_ID}/email`)
      .set(auth(operator))
      .expect(200);
    expect(harness.customerRecipients.calls).toEqual([ACCOUNT_ID, ACCOUNT_ID]);
    // ⚠️ 2 回見たなら、記録も 2 件。
    expect(harness.audit.entries.filter((r) => r.action === 'customer.email.view')).toHaveLength(2);
  });
});

/**
 * 認証基盤へ繋いでいない配備（決定 2026-08-21）。
 *
 * ⚠️ **起動できること自体が受入条件。** 必須にすると、繋いでいない配備で
 * **アプリ全体が立ち上がらない**。口は生やしたまま「この配備では
 * 取り寄せられません」と断る。
 */
describe('認証基盤へ繋いでいない配備', () => {
  let bare: INestApplication;
  let bareHarness: TestHarness;

  beforeEach(async () => {
    bareHarness = buildHarness(
      new DevTokenVerifier({
        secret: TEST_TOKEN_SECRET,
        issuer: TEST_ISSUER,
        audience: TEST_AUDIENCE,
        now: () => TEST_NOW,
      }),
    );
    // ⚠️ **繋いでいない状態を作る。** 設定漏れの配備を再現する。
    const deps = {
      ...bareHarness,
      customers: {
        directory: bareHarness.customerDirectory,
        notes: bareHarness.accountNotes,
        emailChanges: bareHarness.emailChangeRequests,
      },
    };
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(deps)],
    }).compile();
    bare = moduleRef.createNestApplication({ rawBody: true });
    bare.useGlobalFilters(new DomainErrorFilter());
    await bare.init();
  });

  afterEach(async () => {
    await bare.close();
  });

  it('起動する', () => {
    expect(bare).toBeDefined();
  });

  /*
    ⚠️ **「取れなかった」と混ぜない。** 混ぜると、設定漏れが
       「たまたま失敗した」に見えて、いつまでも直されない。
  */
  it('「この配備では取り寄せられません」と断る', async () => {
    bareHarness.accounts.seed('user-operator', 'operator');
    bareHarness.customerDirectory.summaries = [
      {
        accountId: ACCOUNT_ID,
        maskedEmail: null,
        commonUserId: null,
        status: 'active',
        orderCount: 1,
        paidAmount: 12_000,
        refundedAmount: 0,
        entitlementCount: 1,
        unclaimedCount: 0,
        firstOrderAt: TEST_NOW,
        lastOrderAt: TEST_NOW,
      },
    ];

    const response = await request(bare.getHttpServer())
      .get(`/api/v1/admin/customers/${ACCOUNT_ID}/email`)
      .set(auth(tokenFor('user-operator')))
      .expect(200);
    expect(response.body).toEqual({ status: 'not_configured' });
  });
});
