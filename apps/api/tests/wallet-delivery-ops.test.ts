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
 * 送信の運用画面と監査ログ（管理画面・外部連携 指示書 §5・§20）。
 *
 * ⚠️ **この試験の主題は「出ないこと」と「押しても何も起きないときに黙らないこと」。**
 * 送信本文・API キー・HMAC 署名値・`Authorization` ヘッダーは §5 の禁止事項。
 * 再送は、戻せなかった行を「成功」に丸めないことがいちばん重要。
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

function actorToken(role: Role, subject: string, options: { isOwner?: boolean } = {}): string {
  harness.accounts.seed(subject, role, { isOwner: options.isOwner ?? false });
  return tokenFor(subject);
}

function auth(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
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

describe('送信履歴に手が届く範囲', () => {
  it('未認証では一覧を見られない', async () => {
    await request(app.getHttpServer()).get('/api/v1/admin/wallet-deliveries').expect(401);
  });

  it('会員は一覧を見られない', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/wallet-deliveries')
      .set(auth(actorToken('buyer', 'buyer-1')))
      .expect(403);
  });

  it('運営は一覧を見られる', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/wallet-deliveries')
      .set(auth(actorToken('operator', 'ops-1')))
      .expect(200);
  });

  it('閲覧者も一覧を見られる', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/wallet-deliveries')
      .set(auth(actorToken('auditor', 'audit-1')))
      .expect(200);
  });

  /*
    ⚠️ **閲覧者に再送させない。** 状態を変え、相手のシステムへ実際に
       通信が飛ぶ操作。見るための権限で押せてはいけない。
  */
  it('閲覧者は再送できない', async () => {
    harness.deliveries.seed({ id: 'd1', status: 'DEAD' });
    await request(app.getHttpServer())
      .post('/api/v1/admin/wallet-deliveries/resend')
      .set(auth(actorToken('auditor', 'audit-1')))
      .send({ ids: ['d1'] })
      .expect(403);
  });

  /*
    ⚠️ **再送にオーナーの印を要求しない。** 運営の日常業務であり、
       送る内容は行に確定していて、新しく何かを決める操作ではない。
       ここが印つきになると、失敗の復旧がオーナー待ちになる。
  */
  it('印の無い運営でも再送できる', async () => {
    harness.deliveries.seed({ id: 'd1', status: 'DEAD' });
    const response = await request(app.getHttpServer())
      .post('/api/v1/admin/wallet-deliveries/resend')
      .set(auth(actorToken('operator', 'ops-1', { isOwner: false })))
      .send({ ids: ['d1'] })
      .expect(201);
    expect(response.body.results).toEqual([{ id: 'd1', outcome: 'requeued' }]);
  });
});

describe('送信履歴の中身（指示書 §5）', () => {
  it('本文・資格情報・署名値をどこにも出さない', async () => {
    harness.deliveries.seed({ id: 'd1', status: 'FAILED', lastErrorCode: 'http_503' });

    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/wallet-deliveries')
      .set(auth(actorToken('operator', 'ops-1')))
      .expect(200);

    const body = JSON.stringify(response.body);
    for (const forbidden of [
      'payload"',
      'authorization',
      'apiKey',
      'api_key',
      'signature',
      'hmac',
    ]) {
      expect(body.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    // 相手方と突き合わせるのに要るものは返っている。
    expect(response.body.items[0].eventId).toBe('evt_d1');
    expect(response.body.items[0].correlationId).toBe('corr_test');
    expect(response.body.items[0].payloadHash).toMatch(/^sha256:/);
  });

  it('1 件取得でも本文を出さない', async () => {
    harness.deliveries.seed({ id: 'd1' });

    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/wallet-deliveries/d1')
      .set(auth(actorToken('operator', 'ops-1')))
      .expect(200);

    expect(Object.keys(response.body)).not.toContain('payload');
  });

  it('無い行は 404', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/wallet-deliveries/missing')
      .set(auth(actorToken('operator', 'ops-1')))
      .expect(404);
  });

  /*
    ⚠️ 「失敗の欄が無い」と「失敗が 0 件」は、見た人にとって違う意味になる。
  */
  it('件数は 1 件も無い状態も 0 として返す', async () => {
    harness.deliveries.seed({ id: 'd1', status: 'DEAD' });

    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/wallet-deliveries')
      .set(auth(actorToken('operator', 'ops-1')))
      .expect(200);

    expect(response.body.counts).toEqual({
      PENDING: 0,
      PROCESSING: 0,
      DELIVERED: 0,
      FAILED: 0,
      DEAD: 1,
      // ⚠️ 0 件でも欄を出す。「欄が無い」と「0 件」は見た人にとって違う。
      SUPERSEDED: 0,
    });
  });

  /*
    ⚠️ **絞り込んでも件数は全体のまま。** ここが絞り込みに引きずられると、
       「FAILED だけ表示」した画面に「失敗 0 件」と出る。
  */
  it('絞り込んでも件数は全体を指す', async () => {
    harness.deliveries.seed({ id: 'd1', status: 'DEAD' });
    harness.deliveries.seed({ id: 'd2', status: 'DELIVERED' });

    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/wallet-deliveries?status=DELIVERED')
      .set(auth(actorToken('operator', 'ops-1')))
      .expect(200);

    expect(response.body.items).toHaveLength(1);
    expect(response.body.counts.DEAD).toBe(1);
  });

  it('知らない状態名で絞り込んでも一覧は開ける', async () => {
    harness.deliveries.seed({ id: 'd1' });

    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/wallet-deliveries?status=SOMETHING_ELSE')
      .set(auth(actorToken('operator', 'ops-1')))
      .expect(200);

    expect(response.body.items).toHaveLength(1);
  });
});

describe('手による再送（指示書 §20）', () => {
  /*
    ⚠️ **ここが本丸。** `PROCESSING` の行は送信中か、送信直後に落ちた
       可能性がある。届いたか分からない状態で押し直すと、相手の冪等性だけが
       最後の砦になる。断ったことを、押した人に伝えること。
  */
  it('送信中の行は戻さず、戻せなかったと伝える', async () => {
    harness.deliveries.seed({ id: 'd1', status: 'PROCESSING' });

    const response = await request(app.getHttpServer())
      .post('/api/v1/admin/wallet-deliveries/resend')
      .set(auth(actorToken('operator', 'ops-1')))
      .send({ ids: ['d1'] })
      .expect(201);

    expect(response.body.results).toEqual([{ id: 'd1', outcome: 'not_resendable' }]);
    expect((await harness.deliveries.findById('d1'))?.status).toBe('PROCESSING');
  });

  it('届いた行も戻さない', async () => {
    harness.deliveries.seed({ id: 'd1', status: 'DELIVERED', deliveredAt: TEST_NOW });

    const response = await request(app.getHttpServer())
      .post('/api/v1/admin/wallet-deliveries/resend')
      .set(auth(actorToken('operator', 'ops-1')))
      .send({ ids: ['d1'] })
      .expect(201);

    expect(response.body.results[0].outcome).toBe('not_resendable');
  });

  /*
    ⚠️ **まとめて成功にしない。** 1 件でも戻せなかったら、その行の結果を
       そのまま返す。「3 件送り直しました」とだけ言われると、
       戻らなかった行が誰にも気づかれず残る。
  */
  it('戻せた行と戻せなかった行を、1 件ずつ返す', async () => {
    harness.deliveries.seed({ id: 'd1', status: 'DEAD' });
    harness.deliveries.seed({ id: 'd2', status: 'PROCESSING' });
    harness.deliveries.seed({ id: 'd3', status: 'FAILED' });

    const response = await request(app.getHttpServer())
      .post('/api/v1/admin/wallet-deliveries/resend')
      .set(auth(actorToken('operator', 'ops-1')))
      .send({ ids: ['d1', 'd2', 'd3', 'missing'] })
      .expect(201);

    expect(response.body.results).toEqual([
      { id: 'd1', outcome: 'requeued' },
      { id: 'd2', outcome: 'not_resendable' },
      { id: 'd3', outcome: 'requeued' },
      { id: 'missing', outcome: 'not_found' },
    ]);
  });

  it('戻すと試行回数が 0 になり、次の巡回の対象になる', async () => {
    harness.deliveries.seed({ id: 'd1', status: 'DEAD', attemptCount: 5 });

    await request(app.getHttpServer())
      .post('/api/v1/admin/wallet-deliveries/resend')
      .set(auth(actorToken('operator', 'ops-1')))
      .send({ ids: ['d1'] })
      .expect(201);

    const row = await harness.deliveries.findById('d1');
    expect(row?.status).toBe('PENDING');
    expect(row?.attemptCount).toBe(0);
  });

  it('押した事実を、戻せなかったときも監査ログへ残す', async () => {
    harness.deliveries.seed({ id: 'd1', status: 'PROCESSING' });

    await request(app.getHttpServer())
      .post('/api/v1/admin/wallet-deliveries/resend')
      .set(auth(actorToken('operator', 'ops-1')))
      .send({ ids: ['d1'] })
      .expect(201);

    const entry = harness.audit.entries.find((row) => row.action === 'wallet_delivery.resend');
    expect(entry?.summary).toMatchObject({ statusBefore: 'PROCESSING', requeued: false });
    // ⚠️ 監査ログにも本文・ハッシュを残さない。
    expect(JSON.stringify(entry?.summary)).not.toContain('sha256');
  });

  it('同じ行を 2 回指定しても、監査ログは 1 行', async () => {
    harness.deliveries.seed({ id: 'd1', status: 'DEAD' });

    await request(app.getHttpServer())
      .post('/api/v1/admin/wallet-deliveries/resend')
      .set(auth(actorToken('operator', 'ops-1')))
      .send({ ids: ['d1', 'd1'] })
      .expect(201);

    expect(harness.audit.entries.filter((e) => e.action === 'wallet_delivery.resend')).toHaveLength(
      1,
    );
  });

  it('対象が空の要求は断る', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/admin/wallet-deliveries/resend')
      .set(auth(actorToken('operator', 'ops-1')))
      .send({ ids: [] })
      .expect(400);
  });
});

describe('監査ログの閲覧（指示書 §5）', () => {
  it('未認証では見られない', async () => {
    await request(app.getHttpServer()).get('/api/v1/admin/audit-logs').expect(401);
  });

  it('会員は見られない', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/audit-logs')
      .set(auth(actorToken('buyer', 'buyer-1')))
      .expect(403);
  });

  it('閲覧者は見られる', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/audit-logs')
      .set(auth(actorToken('auditor', 'audit-1')))
      .expect(200);
  });

  /*
    ⚠️ **要約の中の連絡先まで伏せる。** スタッフ招待の要約には
       招待先のメールアドレスが入っている。「操作者の連絡先」だけを
       伏せても、要約から漏れる。
  */
  it('印の無い運営には、連絡先を伏せて返す', async () => {
    await harness.audit.record({
      actorAccountId: 'account-ops-1',
      action: 'staff.invite',
      targetType: 'staff_invitation',
      targetId: 'inv-1',
      summary: { email: 'invited@example.com', role: 'operator' },
    });
    harness.auditLogReader.setEmail('account-ops-1', 'ops@example.com');

    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/audit-logs')
      .set(auth(actorToken('operator', 'ops-1', { isOwner: false })))
      .expect(200);

    const body = JSON.stringify(response.body);
    expect(body).not.toContain('invited@example.com');
    expect(body).not.toContain('ops@example.com');
    expect(response.body.contactRedacted).toBe(true);
    // ⚠️ 伏せても「誰が・何を」は残る。監査として意味を失わせない。
    expect(response.body.items[0].action).toBe('staff.invite');
    expect(response.body.items[0].summary.role).toBe('operator');
  });

  it('オーナーには連絡先を返す', async () => {
    await harness.audit.record({
      actorAccountId: 'account-owner-1',
      action: 'staff.invite',
      targetType: 'staff_invitation',
      targetId: 'inv-1',
      summary: { email: 'invited@example.com', role: 'operator' },
    });
    harness.auditLogReader.setEmail('account-owner-1', 'owner@example.com');

    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/audit-logs')
      .set(auth(actorToken('operator', 'owner-1', { isOwner: true })))
      .expect(200);

    expect(response.body.contactRedacted).toBe(false);
    expect(response.body.items[0].summary.email).toBe('invited@example.com');
    expect(response.body.items[0].actorEmail).toBe('owner@example.com');
  });

  it('操作名の前方一致で絞り込める', async () => {
    await harness.audit.record({
      actorAccountId: null,
      action: 'staff.invite',
      targetType: 'staff_invitation',
      targetId: null,
      summary: {},
    });
    await harness.audit.record({
      actorAccountId: null,
      action: 'artwork.publish',
      targetType: 'artwork',
      targetId: null,
      summary: {},
    });

    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/audit-logs?action=staff.')
      .set(auth(actorToken('operator', 'ops-1')))
      .expect(200);

    expect(response.body.items.map((item: { action: string }) => item.action)).toEqual([
      'staff.invite',
    ]);
  });

  /*
    ⚠️ **監査ログを書き換える経路が無いことを確かめる。** 人が直せる証跡は
       証跡ではない。経路が無いことは、あとから足されたときに気づけるよう
       試験で固定しておく。
  */
  it('書き込む経路が無い', async () => {
    const token = auth(actorToken('operator', 'ops-1', { isOwner: true }));
    await request(app.getHttpServer()).post('/api/v1/admin/audit-logs').set(token).expect(404);
    await request(app.getHttpServer()).delete('/api/v1/admin/audit-logs/x').set(token).expect(404);
  });
});
