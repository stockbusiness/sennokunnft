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
 * 運用確認キュー（M3a）。
 *
 * ⚠️ **この組の主題は 3 つ。**
 *  1. **積む口が無いこと。** 手で足せると、「本当に起きた確認事項」と
 *     「誰かが作った行」が混ざり、件数が意味を失う
 *  2. **消す口が無いこと。** 片づけたい気持ちで消せると、確認しなかった
 *     ことまで消える
 *  3. **見るのと印を付けるのを分けること。** 閲覧者は件数を見られるが、
 *     対応済みにはできない
 */

let app: INestApplication;
let harness: TestHarness;

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

async function seedReview(): Promise<string> {
  await harness.operationsReviews.open({
    subjectType: 'entitlement',
    subjectId: '3f2b1c8e-0d44-4a91-9d1e-7c5a2b6f0e13',
    orderId: '8c1d2e3f-4a5b-6c7d-8e9f-0a1b2c3d4e5f',
    reasonCode: 'wallet_revocation_recipient_unresolved',
    detail: '宛先の共通顧客IDを特定できませんでした。',
    now: TEST_NOW,
  });
  const row = harness.operationsReviews.all[0];
  if (row === undefined) {
    throw new Error('確認事項を積めませんでした');
  }
  return row.id;
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

describe('誰が見て、誰が印を付けられるか', () => {
  it('未認証では見られない', async () => {
    await request(app.getHttpServer()).get('/api/v1/admin/operations-reviews').expect(401);
  });

  it('会員は見られない', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/operations-reviews')
      .set(auth(actorToken('buyer')))
      .expect(403);
  });

  it('監査担当は見られる（残件が見えないと監査にならない）', async () => {
    await seedReview();
    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/operations-reviews')
      .set(auth(actorToken('auditor')))
      .expect(200);
    expect(response.body.items).toHaveLength(1);
  });

  it('監査担当は対応済みにできない', async () => {
    const id = await seedReview();
    await request(app.getHttpServer())
      .post(`/api/v1/admin/operations-reviews/${id}/resolve`)
      .set(auth(actorToken('auditor')))
      .send({ note: null })
      .expect(403);
  });

  it('運営は対応済みにできる', async () => {
    const id = await seedReview();
    await request(app.getHttpServer())
      .post(`/api/v1/admin/operations-reviews/${id}/resolve`)
      .set(auth(actorToken('operator')))
      .send({ note: '返金の対象を確認し、手作業で取り消しました。' })
      .expect(201);

    expect(harness.operationsReviews.all[0]?.status).toBe('resolved');
  });
});

describe('一覧の見え方', () => {
  it('未対応の件数は、絞り込みの影響を受けない', async () => {
    /*
      ⚠️ 絞った結果の件数を出すと、「0 件だから何も無い」と読み違える。
    */
    await seedReview();
    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/operations-reviews?status=resolved')
      .set(auth(actorToken('operator')))
      .expect(200);

    expect(response.body.items).toHaveLength(0);
    expect(response.body.openCounts.wallet_revocation_recipient_unresolved).toBe(1);
  });

  it('知らない絞り込みは黙って捨てる（一覧そのものは開ける）', async () => {
    await seedReview();
    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/operations-reviews?status=unknown&reasonCode=nope')
      .set(auth(actorToken('operator')))
      .expect(200);

    expect(response.body.items).toHaveLength(1);
  });

  it('個人情報を返さない', async () => {
    await seedReview();
    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/operations-reviews')
      .set(auth(actorToken('operator')))
      .expect(200);

    const serialized = JSON.stringify(response.body);
    for (const forbidden of ['email', 'commonUserId', 'common_user_id']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe('作れない・消せない', () => {
  it('手で積む口が無い', async () => {
    // ⚠️ 積むのは業務処理の側だけ。手で足せると件数が意味を失う。
    await request(app.getHttpServer())
      .post('/api/v1/admin/operations-reviews')
      .set(auth(actorToken('operator')))
      .send({ reasonCode: 'partial_refund_entitlement_unresolved' })
      .expect(404);
  });

  it('消す口も無い', async () => {
    const id = await seedReview();
    await request(app.getHttpServer())
      .delete(`/api/v1/admin/operations-reviews/${id}`)
      .set(auth(actorToken('operator')))
      .expect(404);
  });

  it('二度目の「対応済み」は断る（誰が確認したかを書き換えさせない）', async () => {
    const id = await seedReview();
    await request(app.getHttpServer())
      .post(`/api/v1/admin/operations-reviews/${id}/resolve`)
      .set(auth(actorToken('operator')))
      .send({ note: null })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/api/v1/admin/operations-reviews/${id}/resolve`)
      .set(auth(actorToken('operator', 'user-operator-2')))
      .send({ note: null })
      .expect(409);
  });
});
