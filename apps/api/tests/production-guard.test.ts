import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createDevToken, DevTokenVerifier } from '@sengoku/integrations';
import type { Role } from '@sengoku/auth';
import { AppModule } from '../src/app.module';
import { DomainErrorFilter } from '../src/common/domain-error.filter';
import {
  buildHarness,
  sampleArtwork,
  sampleListing,
  TEST_AUDIENCE,
  TEST_ISSUER,
  TEST_NOW,
  TEST_TOKEN_SECRET,
  type TestHarness,
} from './helpers/doubles';

/**
 * 本番販売ガード（実運営 指示書 P0-7）。
 *
 * ⚠️ **この組の主題は 5 つ。**
 *  1. **条件未達で本番の支払い口を作らせないこと。** 画面を隠すだけでは
 *     この口は直接叩ける
 *  2. **staging では止めないこと。** 止めると誰も試せず、本番で初めて動かす
 *  3. **証跡を残せるのはオーナーだけで、押した記録が残ること**
 *  4. **鍵が替われば証跡が失効すること**
 *  5. **購入者へ理由の内訳を出さないこと**
 */

const LISTING_ID = '11111111-1111-4111-8111-111111111111';

let app: INestApplication;
let harness: TestHarness;

function tokenFor(subject: string): string {
  return createDevToken(TEST_TOKEN_SECRET, {
    sub: subject,
    iss: TEST_ISSUER,
    aud: TEST_AUDIENCE,
    exp: Math.floor(TEST_NOW.getTime() / 1000) + 3600,
    // ⚠️ 承認の口は再認証を求める。試験のトークンも「いま発行した」形にする。
    iat: Math.floor(TEST_NOW.getTime() / 1000),
  });
}

function actorToken(role: Role, subject = `user-${role}`, isOwner = false): string {
  harness.accounts.seed(subject, role, { isOwner });
  return tokenFor(subject);
}

function ownerToken(): string {
  return actorToken('operator', 'user-owner', true);
}

function auth(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

/**
 * 組み立て。
 *
 * ⚠️ **既定は `staging`。** 判定はするが止めない。止まることを確かめる
 * 試験だけが `production` へ差し替える。
 */
async function boot(environment: 'staging' | 'production' = 'staging'): Promise<void> {
  harness = buildHarness(
    new DevTokenVerifier({
      secret: TEST_TOKEN_SECRET,
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
      now: () => TEST_NOW,
    }),
  );
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.register({
        ...harness,
        production: { ...harness.production, environment },
      }),
    ],
  }).compile();
  app = moduleRef.createNestApplication({ rawBody: true });
  app.useGlobalFilters(new DomainErrorFilter());
  await app.init();
}

function seedPurchasable(): void {
  harness.artworks.seed(sampleArtwork({ maxSupply: 3 }));
  harness.listings.seed(sampleListing({ id: LISTING_ID }));
}

async function createOrder(token: string): Promise<string> {
  const response = await request(app.getHttpServer())
    .post('/api/v1/orders')
    .set(auth(token))
    .send({ listingId: LISTING_ID, idempotencyKey: randomUUID() })
    .expect(201);
  return response.body.order.id as string;
}

function createCheckout(orderId: string, token: string) {
  return request(app.getHttpServer())
    .post(`/api/v1/orders/${orderId}/checkout-session`)
    .set(auth(token));
}

beforeEach(async () => {
  await boot();
});

afterEach(async () => {
  await app.close();
});

describe('誰が見て、誰が署名できるか', () => {
  it('未認証では見られない', async () => {
    await request(app.getHttpServer()).get('/api/v1/admin/production/readiness').expect(401);
  });

  it('会員は見られない', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/production/readiness')
      .set(auth(actorToken('buyer')))
      .expect(403);
  });

  it('監査担当は見られる（本番販売の可否は監査の対象）', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/production/readiness')
      .set(auth(actorToken('auditor')))
      .expect(200);
  });

  /*
    ⚠️ **押した記録が 10 条件のうち 2 つを埋める。** 運営の 1 人が
       乗っ取られただけで本番販売が始められる状態にしない。
  */
  it('印の無い運営は証跡を残せない', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/admin/production/attestations')
      .set(auth(actorToken('operator')))
      .send({ kind: 'owner_approval', succeeded: true, note: null })
      .expect(403);
  });

  it('監査担当は証跡を残せない', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/admin/production/attestations')
      .set(auth(actorToken('auditor')))
      .send({ kind: 'owner_approval', succeeded: true, note: null })
      .expect(403);
  });
});

describe('10 条件の見え方', () => {
  /*
    ⚠️ **立ち上げた直後は 10 個すべて未達。** 既定で通ってしまう作りに
       しない。ここが「そろっている」と出たら、判定が壊れている。
  */
  it('何もしていなければ 10 個すべて未達', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/production/readiness')
      .set(auth(actorToken('operator')))
      .expect(200);

    expect(response.body.ready).toBe(false);
    expect(response.body.checks).toHaveLength(10);
    expect(response.body.checks.every((row: { satisfied: boolean }) => !row.satisfied)).toBe(true);
  });

  it('どの条件にも、状態と次の一手が付く', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/production/readiness')
      .set(auth(actorToken('operator')))
      .expect(200);

    for (const row of response.body.checks) {
      expect(row.detail, `${row.key} に状態の説明が無い`).toBeTruthy();
      expect(row.remedy, `${row.key} に次の一手が無い`).toBeTruthy();
    }
  });

  it('そろえば通る', async () => {
    harness.productionReadiness.makeReady(TEST_NOW);
    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/production/readiness')
      .set(auth(actorToken('operator')))
      .expect(200);
    expect(response.body.ready).toBe(true);
  });

  /*
    ⚠️ **鍵も署名鍵も返さない。** 返すのは有無と確認の結果まで。
  */
  it('応答に鍵らしき値が現れない', async () => {
    harness.productionReadiness.makeReady(TEST_NOW);
    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/production/readiness')
      .set(auth(actorToken('operator')))
      .expect(200);

    const body = JSON.stringify(response.body).toLowerCase();
    for (const forbidden of ['sk_', 'whsec', 'secret', 'apikey', 'api_key']) {
      expect(body).not.toContain(forbidden);
    }
  });

  /** staging では判定するが止めない。 */
  it('staging では止めないことが応答から分かる', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/production/readiness')
      .set(auth(actorToken('operator')))
      .expect(200);
    expect(response.body.enforced).toBe(false);
    expect(response.body.environment).toBe('staging');
  });

  it('本番では止めることが応答から分かる', async () => {
    await app.close();
    await boot('production');
    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/production/readiness')
      .set(auth(actorToken('operator')))
      .expect(200);
    expect(response.body.enforced).toBe(true);
  });
});

describe('支払い口の作成', () => {
  /*
    ⚠️ **staging で止めると誰も試せず、本番で初めて動かすことになる。**
  */
  it('staging では、条件が未達でも支払い口を作れる', async () => {
    seedPurchasable();
    const token = actorToken('buyer');
    const orderId = await createOrder(token);
    await createCheckout(orderId, token).expect(201);
  });

  /*
    ⚠️ **これが本題。** 画面を隠すだけでは、この口は直接叩ける。
  */
  it('本番では、条件が未達なら支払い口を作れない', async () => {
    await app.close();
    await boot('production');
    seedPurchasable();
    const token = actorToken('buyer');
    const orderId = await createOrder(token);
    await createCheckout(orderId, token).expect(409);
  });

  /*
    ⚠️ **購入者へ理由の内訳を出さない。** どの条件が欠けているかは
       運営の内部事情である。
  */
  it('断る言葉に、どの条件が欠けているかを書かない', async () => {
    await app.close();
    await boot('production');
    seedPurchasable();
    const token = actorToken('buyer');
    const orderId = await createOrder(token);
    const response = await createCheckout(orderId, token).expect(409);

    const body = JSON.stringify(response.body);
    for (const leak of ['webhook', 'mfa', 'credential', '手数料', '規約', '二要素']) {
      expect(body.toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });

  it('本番でも、条件がそろえば支払い口を作れる', async () => {
    await app.close();
    await boot('production');
    harness.productionReadiness.makeReady(TEST_NOW);
    seedPurchasable();
    const token = actorToken('buyer');
    const orderId = await createOrder(token);
    await createCheckout(orderId, token).expect(201);
  });

  /*
    ⚠️ **判定を毎回やり直す。** 「一度そろったから以後は通す」という
       記憶を持たない。条件は崩れるもので、崩れたことに気づかないまま
       売り続けるのがいちばん困る。
  */
  it('一度そろっても、崩れたら次から止まる', async () => {
    await app.close();
    await boot('production');
    harness.productionReadiness.makeReady(TEST_NOW);
    seedPurchasable();
    const token = actorToken('buyer');

    await createCheckout(await createOrder(token), token).expect(201);

    // 時計が止まった。
    harness.productionReadiness.facts_ = { ...harness.productionReadiness.facts_, jobs: [] };
    await createCheckout(await createOrder(token), token).expect(409);
  });
});

describe('人が残す証跡', () => {
  beforeEach(() => {
    harness.productionReadiness.makeReady(TEST_NOW);
  });

  it('オーナーは記録できる', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/admin/production/attestations')
      .set(auth(ownerToken()))
      .send({ kind: 'e2e_sale_test', succeeded: true, note: '1 件購入し、お届けまで通りました。' })
      .expect(201);
    expect(response.body.id).toBeTruthy();
    expect(harness.attestations.rows).toHaveLength(1);
  });

  /*
    ⚠️ **`credentialId` を要求から受け取らない。** 受け取れると、いま
       受付中でない世代を指す証跡を作れてしまう。
  */
  it('決済世代は要求から指定できない（サーバー側で紐づける）', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/admin/production/attestations')
      .set(auth(ownerToken()))
      .send({
        kind: 'owner_approval',
        succeeded: true,
        note: null,
        credentialId: 'someone-elses-credential',
      })
      .expect(201);

    expect(harness.attestations.rows[0]?.credentialId).toBe('credential-1');
  });

  it('押した人が残る', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/admin/production/attestations')
      .set(auth(ownerToken()))
      .send({ kind: 'owner_approval', succeeded: true, note: null })
      .expect(201);

    expect(harness.attestations.rows[0]?.attestedByAccountId).toBe('account-user-owner');
    expect(harness.audit.actions()).toContain('production.attest');
  });

  it('「不成立」には理由が要る', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/admin/production/attestations')
      .set(auth(ownerToken()))
      .send({ kind: 'e2e_sale_test', succeeded: false, note: null })
      .expect(422);
  });

  /*
    ⚠️ **紐づける先が無い証跡を作らせない。** 何の証拠にもならない。
  */
  it('受付中の決済世代が無ければ記録できない', async () => {
    harness.productionReadiness.facts_ = {
      ...harness.productionReadiness.facts_,
      acceptingCredential: null,
    };
    await request(app.getHttpServer())
      .post('/api/v1/admin/production/attestations')
      .set(auth(ownerToken()))
      .send({ kind: 'owner_approval', succeeded: true, note: null })
      .expect(422);
  });

  /*
    ⚠️ **10 条件が満たされる前でも承認は記録できる。** 順序を強制すると、
       鍵の切り替え日に合わせて段取りする運用ができなくなる。押した記録は
       残り、条件の判定は毎回やり直されるので、早く押しても近道にならない。
  */
  it('条件が未達でも、承認そのものは記録できる', async () => {
    harness.productionReadiness.facts_ = { ...harness.productionReadiness.facts_, jobs: [] };
    await request(app.getHttpServer())
      .post('/api/v1/admin/production/attestations')
      .set(auth(ownerToken()))
      .send({ kind: 'owner_approval', succeeded: true, note: null })
      .expect(201);
  });

  it('押された記録は一覧で読める（消せないので、やり直した回数も読める）', async () => {
    const token = ownerToken();
    await request(app.getHttpServer())
      .post('/api/v1/admin/production/attestations')
      .set(auth(token))
      .send({ kind: 'e2e_sale_test', succeeded: false, note: '配送の巡回で止まりました。' })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/admin/production/attestations')
      .set(auth(token))
      .send({ kind: 'e2e_sale_test', succeeded: true, note: '直したうえで通しました。' })
      .expect(201);

    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/production/attestations')
      .set(auth(actorToken('auditor')))
      .expect(200);
    expect(response.body.items).toHaveLength(2);
  });

  /*
    ⚠️ **書き換える口も消す口も無い。** 訂正は新しい記録を足して表す。
  */
  it.each([
    ['書き換え', 'patch'],
    ['削除', 'delete'],
  ] as const)('%s の口は存在しない', async (_label, method) => {
    const token = ownerToken();
    await request(app.getHttpServer())
      .post('/api/v1/admin/production/attestations')
      .set(auth(token))
      .send({ kind: 'owner_approval', succeeded: true, note: null })
      .expect(201);

    await request(app.getHttpServer())
      [method]('/api/v1/admin/production/attestations/attestation-1')
      .set(auth(token))
      .send({ succeeded: false })
      .expect(404);
  });
});

describe('メールの試し送り', () => {
  it('運営は押せる', async () => {
    harness.accounts.seed('user-operator', 'operator');
    harness.staffMembers.setStaffEmail('account-user-operator', 'ops@example.test');

    const response = await request(app.getHttpServer())
      .post('/api/v1/admin/production/mail-check')
      .set(auth(actorToken('operator')))
      .expect(201);

    expect(response.body.succeeded).toBe(true);
    expect(harness.mailTestSender.sent).toHaveLength(1);
  });

  /*
    ⚠️ **宛先は押した本人の業務用アドレスだけ。** 受け取る形にすると、
       この口が「任意の相手へメールを送れる口」になる。
  */
  it('宛先を指定しても、押した本人へ送られる', async () => {
    harness.accounts.seed('user-operator', 'operator');
    harness.staffMembers.setStaffEmail('account-user-operator', 'ops@example.test');

    await request(app.getHttpServer())
      .post('/api/v1/admin/production/mail-check')
      .set(auth(actorToken('operator')))
      .send({ to: 'stranger@example.test' })
      .expect(201);

    expect(harness.mailTestSender.sent[0]?.to).toBe('ops@example.test');
  });

  /*
    ⚠️ **平文の宛先を返さない**（`UD-503`）。
  */
  it('応答に平文の宛先が現れない', async () => {
    harness.accounts.seed('user-operator', 'operator');
    harness.staffMembers.setStaffEmail('account-user-operator', 'ops@example.test');

    const response = await request(app.getHttpServer())
      .post('/api/v1/admin/production/mail-check')
      .set(auth(actorToken('operator')))
      .expect(201);

    expect(JSON.stringify(response.body)).not.toContain('ops@example.test');
    expect(response.body.maskedRecipient).toContain('*');
  });

  it('業務用アドレスが未登録なら断る', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/admin/production/mail-check')
      .set(auth(actorToken('operator')))
      .expect(422);
  });

  it('失敗しても記録に残る', async () => {
    harness.accounts.seed('user-operator', 'operator');
    harness.staffMembers.setStaffEmail('account-user-operator', 'ops@example.test');
    harness.mailTestSender.outcome = { kind: 'rejected', statusCode: 401 };

    const response = await request(app.getHttpServer())
      .post('/api/v1/admin/production/mail-check')
      .set(auth(actorToken('operator')))
      .expect(201);

    expect(response.body.succeeded).toBe(false);
    expect(response.body.failureCode).toBe('REJECTED');
    expect(harness.audit.actions()).toContain('production.mail_check');
  });

  it('監査担当は押せない（外部へ実際に送る操作）', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/admin/production/mail-check')
      .set(auth(actorToken('auditor')))
      .expect(403);
  });
});
