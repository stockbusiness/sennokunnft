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
 * 決済資格情報の世代（`UD-118`）。
 *
 * ⚠️ **この組の主題は 3 つ。**
 *  1. 鍵がどこにも出ないこと（値・先頭・末尾 4 文字とも）
 *  2. 接続確認を通らずに有効化できないこと（二者承認をやめた代わりの守り）
 *  3. 入金先が変わる操作にオーナーの印と再認証が要ること
 */

let app: INestApplication;
let harness: TestHarness;

const LIVE_KEY = 'sk_live_verysecretkey0123456789';
const WEBHOOK_KEY = 'whsec_verysecretsignature0123';

/** ⚠️ 発行時刻を指定できるようにしてある。再認証の試験で使う。 */
function tokenFor(subject: string, issuedSecondsAgo = 0): string {
  const nowSeconds = Math.floor(TEST_NOW.getTime() / 1000);
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

const CONFIRM = { confirmation: 'production' };

async function registerGeneration(token: string, label: string): Promise<string> {
  const response = await request(app.getHttpServer())
    .post('/api/v1/admin/payment-credentials')
    .set(auth(token))
    .send({ label, secretKey: LIVE_KEY, webhookSecret: WEBHOOK_KEY })
    .expect(201);
  const generations = response.body.generations as { id: string; label: string }[];
  const found = generations.find((row) => row.label === label);
  if (found === undefined) {
    throw new Error('registration did not appear');
  }
  return found.id;
}

async function registerAndCheck(token: string, label: string): Promise<string> {
  const id = await registerGeneration(token, label);
  await request(app.getHttpServer())
    .post(`/api/v1/admin/payment-credentials/${id}/check`)
    .set(auth(token))
    .expect(201);
  return id;
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
  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new DomainErrorFilter());
  await app.init();
});

afterEach(async () => {
  await app.close();
});

describe('誰が触れるか', () => {
  it('未認証では一覧を見られない', async () => {
    await request(app.getHttpServer()).get('/api/v1/admin/payment-credentials').expect(401);
  });

  it('会員は一覧を見られない', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/payment-credentials')
      .set(auth(actorToken('buyer', 'buyer-1')))
      .expect(403);
  });

  it('運営は一覧を見られる（決済が止まった原因を追えるように）', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/payment-credentials')
      .set(auth(actorToken('operator', 'ops-1')))
      .expect(200);
  });

  /*
    ⚠️ **入金先が変わる操作。** 運営の 1 人が乗っ取られただけで売上の
       振込先を差し替えられる形にしない。
  */
  it('印の無い運営は登録できない', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/admin/payment-credentials')
      .set(auth(actorToken('operator', 'ops-2')))
      .send({ secretKey: LIVE_KEY, webhookSecret: WEBHOOK_KEY })
      .expect(403);
  });

  it('印を持つ運営は登録できる', async () => {
    await registerGeneration(actorToken('operator', 'owner-1', { isOwner: true }), '初代');
  });
});

describe('再認証', () => {
  /*
    ⚠️ **401 で返す。** 403 だと「権限が無い」と読まれ、ログインし直せば
       通ることが伝わらない。
  */
  it('ログインから時間が経っていれば登録を断る', async () => {
    const stale = actorToken('operator', 'owner-2', { isOwner: true, issuedSecondsAgo: 600 });
    await request(app.getHttpServer())
      .post('/api/v1/admin/payment-credentials')
      .set(auth(stale))
      .send({ secretKey: LIVE_KEY, webhookSecret: WEBHOOK_KEY })
      .expect(401);
  });

  it('接続確認には再認証を求めない（何も変えない操作）', async () => {
    const fresh = actorToken('operator', 'owner-3', { isOwner: true });
    const id = await registerGeneration(fresh, '初代');

    const stale = actorToken('operator', 'owner-3', { isOwner: true, issuedSecondsAgo: 600 });
    await request(app.getHttpServer())
      .post(`/api/v1/admin/payment-credentials/${id}/check`)
      .set(auth(stale))
      .expect(201);
  });

  it('一覧の閲覧にも再認証を求めない', async () => {
    const stale = actorToken('operator', 'ops-3', { issuedSecondsAgo: 3000 });
    await request(app.getHttpServer())
      .get('/api/v1/admin/payment-credentials')
      .set(auth(stale))
      .expect(200);
  });
});

describe('接続確認を通らないと有効化できない', () => {
  it('確認していない世代は有効化できない', async () => {
    const token = actorToken('operator', 'owner-4', { isOwner: true });
    const id = await registerGeneration(token, '初代');

    const response = await request(app.getHttpServer())
      .post(`/api/v1/admin/payment-credentials/${id}/activate`)
      .set(auth(token))
      .send(CONFIRM)
      .expect(409);
    expect(response.body.error.code).toBe('PAYMENT_CREDENTIAL_CHECK_REQUIRED');
  });

  it('確認を通れば有効化でき、受付世代になる', async () => {
    const token = actorToken('operator', 'owner-5', { isOwner: true });
    const id = await registerAndCheck(token, '初代');

    const response = await request(app.getHttpServer())
      .post(`/api/v1/admin/payment-credentials/${id}/activate`)
      .set(auth(token))
      .send(CONFIRM)
      .expect(201);

    expect(response.body.canAcceptPayments).toBe(true);
    const activated = (
      response.body.generations as { id: string; acceptsNewPayments: boolean }[]
    ).find((row) => row.id === id);
    expect(activated?.acceptsNewPayments).toBe(true);
  });
});

describe('本番での確認入力', () => {
  /*
    ⚠️ **「本当によろしいですか」の一段だけにしない。** 押し慣れると
       意味を失う。手を止めさせるには打たせるのがいちばん確実。
  */
  it('確認の入力が無ければ有効化しない', async () => {
    const token = actorToken('operator', 'owner-6', { isOwner: true });
    const id = await registerAndCheck(token, '初代');

    await request(app.getHttpServer())
      .post(`/api/v1/admin/payment-credentials/${id}/activate`)
      .set(auth(token))
      .send({})
      .expect(400);
  });
});

describe('世代の切り替え', () => {
  it('旧世代は受付を降りるが、退役はしない', async () => {
    const token = actorToken('operator', 'owner-7', { isOwner: true });
    const first = await registerAndCheck(token, '初代');
    await request(app.getHttpServer())
      .post(`/api/v1/admin/payment-credentials/${first}/activate`)
      .set(auth(token))
      .send(CONFIRM)
      .expect(201);

    const second = await registerAndCheck(token, '二代目');
    const response = await request(app.getHttpServer())
      .post(`/api/v1/admin/payment-credentials/${second}/activate`)
      .set(auth(token))
      .send(CONFIRM)
      .expect(201);

    const rows = response.body.generations as {
      id: string;
      status: string;
      acceptsNewPayments: boolean;
      retiredAt: string | null;
    }[];
    const old = rows.find((row) => row.id === first);
    /*
      ⚠️ **返金と照会は旧世代の鍵で続く。** ここで退役させると、
         切り替えた瞬間に過去の注文が返金不能になる。
    */
    expect(old?.status).toBe('active');
    expect(old?.acceptsNewPayments).toBe(false);
    expect(old?.retiredAt).toBeNull();
    expect(rows.find((row) => row.id === second)?.acceptsNewPayments).toBe(true);
  });

  it('受付中の世代は退役させられない（販売が止まる）', async () => {
    const token = actorToken('operator', 'owner-8', { isOwner: true });
    const id = await registerAndCheck(token, '初代');
    await request(app.getHttpServer())
      .post(`/api/v1/admin/payment-credentials/${id}/activate`)
      .set(auth(token))
      .send(CONFIRM)
      .expect(201);

    const response = await request(app.getHttpServer())
      .post(`/api/v1/admin/payment-credentials/${id}/retire`)
      .set(auth(token))
      .send(CONFIRM)
      .expect(409);
    expect(response.body.error.code).toBe('PAYMENT_CREDENTIAL_IN_USE');
  });
});

describe('鍵がどこにも出ない', () => {
  /*
    ⚠️ **末尾 4 文字も出さない**（2026-08-19 決定）。OVEW Wallet では
       出しているが、決済では出さない。判断が分かれているので取り違えない。
  */
  it('一覧に鍵の値も先頭も末尾も出ない', async () => {
    const token = actorToken('operator', 'owner-9', { isOwner: true });
    await registerAndCheck(token, '初代');

    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/payment-credentials')
      .set(auth(token))
      .expect(200);

    const body = JSON.stringify(response.body);
    expect(body).not.toContain(LIVE_KEY);
    expect(body).not.toContain(WEBHOOK_KEY);
    expect(body).not.toContain(LIVE_KEY.slice(-4));
    expect(body).not.toContain(LIVE_KEY.slice(0, 12));
  });

  it('監査ログにも鍵が出ない', async () => {
    const token = actorToken('operator', 'owner-10', { isOwner: true });
    await registerAndCheck(token, '初代');

    const entries = JSON.stringify(harness.audit.entries);
    expect(entries).not.toContain(LIVE_KEY);
    expect(entries).not.toContain(WEBHOOK_KEY);
    expect(entries).not.toContain(LIVE_KEY.slice(-4));
  });

  it('操作の種類と世代番号は監査ログに残る', async () => {
    const token = actorToken('operator', 'owner-11', { isOwner: true });
    const id = await registerAndCheck(token, '初代');
    await request(app.getHttpServer())
      .post(`/api/v1/admin/payment-credentials/${id}/activate`)
      .set(auth(token))
      .send(CONFIRM)
      .expect(201);

    const actions = harness.audit.entries.map((entry) => entry.action);
    expect(actions).toContain('payment_credential.registered');
    expect(actions).toContain('payment_credential.checked');
    expect(actions).toContain('payment_credential.activated');

    const activated = harness.audit.entries.find(
      (entry) => entry.action === 'payment_credential.activated',
    );
    expect(activated?.summary).toMatchObject({ generation: 1 });
  });
});

describe('緊急上書きの表示', () => {
  /*
    ⚠️ **有効なら画面の先頭に出す。** 二重管理が黙って復活している状態が、
       いちばん気づきにくい。
  */
  it('既定では無効と返る', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/payment-credentials')
      .set(auth(actorToken('operator', 'ops-4')))
      .expect(200);
    expect(response.body.emergencyOverrideActive).toBe(false);
  });
});
