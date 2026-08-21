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
  TEST_TOKEN_SECRET,
  type TestHarness,
} from './helpers/doubles';

/**
 * 運営の売上レポートと作家さまの一覧（`UD-123` / `UD-124` の一部）。
 *
 * ⚠️ **この組の主題は 5 つ。**
 *  1. **`auditor` にも開く**こと（数字は監査の対象そのもの）
 *  2. 会員には開かないこと
 *  3. 売れなかった期間も行として出ること（**行が飛ばない**）
 *  4. CSV が画面と同じ数字であること
 *  5. **お振込先の値もご連絡先も、この経路に出ないこと**
 */

/** 2026-08-20 09:00 JST。 */
const NOW = new Date('2026-08-20T00:00:00.000Z');
const CREATOR = '11111111-1111-4111-8111-111111111111';

let app: INestApplication;
let harness: TestHarness;

function tokenFor(subject: string): string {
  const nowSeconds = Math.floor(NOW.getTime() / 1000);
  return createDevToken(TEST_TOKEN_SECRET, {
    sub: subject,
    iss: TEST_ISSUER,
    aud: TEST_AUDIENCE,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  });
}

function actorToken(role: Role, subject: string): string {
  harness.accounts.seed(subject, role, { isOwner: false });
  return tokenFor(subject);
}

function auth(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

function seedCreator(overrides: Record<string, unknown> = {}): void {
  harness.creatorDirectory.rows.set(CREATOR, {
    accountId: CREATOR,
    displayName: '千ノ国 太郎',
    shopName: '千ノ国工房',
    status: 'active',
    artworkCount: 3,
    activeListingCount: 2,
    orderCount: 4,
    grossAmount: 48000,
    refundedAmount: 12000,
    lastSoldAt: new Date('2026-08-19T00:00:00.000Z'),
    salesTermsAcceptedAt: new Date('2026-08-01T00:00:00.000Z'),
    hasPayoutAccount: true,
    ...overrides,
  });
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

describe('誰が見られるか', () => {
  it('未認証では見られない', async () => {
    await request(app.getHttpServer()).get('/api/v1/admin/sales-report').expect(401);
    await request(app.getHttpServer()).get('/api/v1/admin/creators').expect(401);
  });

  it('会員は見られない（ここに出るのは場全体の数字）', async () => {
    const buyer = actorToken('buyer', 'buyer-report-1');
    await request(app.getHttpServer())
      .get('/api/v1/admin/sales-report')
      .set(auth(buyer))
      .expect(403);
    await request(app.getHttpServer()).get('/api/v1/admin/creators').set(auth(buyer)).expect(403);
  });

  /*
    ⚠️ **監査担当にも開く。** いくら売れていくら返したかは監査の対象そのもの。
       誰が買ったかも何を買ったかも含まない。
  */
  it('監査担当は見られる', async () => {
    const auditor = actorToken('auditor', 'auditor-report-1');
    await request(app.getHttpServer())
      .get('/api/v1/admin/sales-report')
      .set(auth(auditor))
      .expect(200);
    await request(app.getHttpServer()).get('/api/v1/admin/creators').set(auth(auditor)).expect(200);
  });
});

describe('売上レポート', () => {
  /*
    ⚠️ **売れなかった日も 0 の行として出す。** 抜かすと、「その日は売れ
       なかった」のか「集計できていない」のかが分からない。
  */
  it('売れなかった日を飛ばさない', async () => {
    harness.salesReport.sales = [
      {
        periodKey: '2026-08-19',
        orderCount: 2,
        grossAmount: 24000,
        platformFeeAmount: 4800,
        creatorAmount: 19200,
      },
    ];

    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/sales-report?granularity=daily')
      .set(auth(actorToken('operator', 'operator-report-1')))
      .expect(200);

    expect(response.body.rows).toHaveLength(30);
    const filled = response.body.rows.find(
      (row: { periodKey: string }) => row.periodKey === '2026-08-19',
    );
    // ⚠️ 空振りでないことを確かめる（全部 0 なら、この試験は何も見ていない）。
    expect(filled).toMatchObject({ orderCount: 2, grossAmount: 24000 });
    expect(
      response.body.rows.filter((row: { grossAmount: number }) => row.grossAmount === 0).length,
    ).toBe(29);
  });

  it('返金は差し引かれ、合計は行と一致する', async () => {
    harness.salesReport.sales = [
      {
        periodKey: '2026-08-19',
        orderCount: 2,
        grossAmount: 24000,
        platformFeeAmount: 4800,
        creatorAmount: 19200,
      },
    ];
    harness.salesReport.refunds = [
      { periodKey: '2026-08-20', refundCount: 1, refundedAmount: 12000 },
    ];

    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/sales-report')
      .set(auth(actorToken('operator', 'operator-report-2')))
      .expect(200);

    expect(response.body.totals).toMatchObject({
      orderCount: 2,
      grossAmount: 24000,
      refundCount: 1,
      refundedAmount: 12000,
      netAmount: 12000,
    });
  });

  it('月次でも取れる', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/sales-report?granularity=monthly')
      .set(auth(actorToken('operator', 'operator-report-3')))
      .expect(200);
    expect(response.body.granularity).toBe('monthly');
    expect(response.body.rows).toHaveLength(12);
  });

  it('知らない粒度は断る', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/sales-report?granularity=hourly')
      .set(auth(actorToken('operator', 'operator-report-4')))
      .expect(400);
  });

  /*
    ⚠️ **画面と CSV が同じ関数から出ていること。** 別々に組み立てると、
       数字が食い違い、どちらが正しいのか誰にも分からなくなる。
  */
  it('CSV が画面と同じ数字を出す', async () => {
    harness.salesReport.sales = [
      {
        periodKey: '2026-08-19',
        orderCount: 2,
        grossAmount: 24000,
        platformFeeAmount: 4800,
        creatorAmount: 19200,
      },
    ];

    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/sales-report/csv')
      .set(auth(actorToken('operator', 'operator-report-5')))
      .expect(200);

    expect(response.headers['content-type']).toContain('text/csv');
    // ⚠️ BOM。付けないと Excel で見出しが化ける。
    expect(response.text.startsWith('\uFEFF')).toBe(true);
    expect(response.text).toContain('"2026-08-19","2","24000","4800","19200","0","0","24000"');
    // ⚠️ 「入金額」とも「消費税」とも書かない（`UD-401` 未決）。
    expect(response.text).not.toContain('入金');
    expect(response.text).not.toContain('消費税');
  });
});

describe('作家さまの一覧', () => {
  it('売上の多い順に並ぶ', async () => {
    seedCreator();
    harness.creatorDirectory.rows.set('22222222-2222-4222-8222-222222222222', {
      accountId: '22222222-2222-4222-8222-222222222222',
      displayName: '甲斐 花子',
      shopName: null,
      status: 'active',
      artworkCount: 1,
      activeListingCount: 1,
      orderCount: 9,
      grossAmount: 90000,
      refundedAmount: 0,
      lastSoldAt: null,
      salesTermsAcceptedAt: null,
      hasPayoutAccount: false,
    });

    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/creators')
      .set(auth(actorToken('operator', 'operator-creator-1')))
      .expect(200);

    expect(response.body.items.map((row: { displayName: string }) => row.displayName)).toEqual([
      '甲斐 花子',
      '千ノ国 太郎',
    ]);
    // ⚠️ 上限を黙って隠さない。画面がそう伝えられるように返す。
    expect(response.body.limit).toBe(100);
  });

  /*
    ⚠️ **お振込先は「預かってあるか」まで。** 銀行名も名義も番号も、
       この経路には出ない。読むのは精算の画面から別の口（権限＋監査）。
    ⚠️ **ご連絡先も出ない**（`UD-503`）。そもそも持っていない。
  */
  it('お振込先の値もご連絡先も出ない', async () => {
    seedCreator();
    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/creators')
      .set(auth(actorToken('operator', 'operator-creator-2')))
      .expect(200);

    expect(response.body.items[0].hasPayoutAccount).toBe(true);
    const body = JSON.stringify(response.body);
    expect(body).not.toContain('accountNumber');
    expect(body).not.toContain('bankName');
    expect(body).not.toContain('email');
  });

  it('表示名で絞れる', async () => {
    seedCreator();
    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/creators?keyword=' + encodeURIComponent('千ノ国'))
      .set(auth(actorToken('operator', 'operator-creator-3')))
      .expect(200);
    expect(response.body.items).toHaveLength(1);

    const miss = await request(app.getHttpServer())
      .get('/api/v1/admin/creators?keyword=' + encodeURIComponent('見つからない'))
      .set(auth(actorToken('operator', 'operator-creator-4')))
      .expect(200);
    expect(miss.body.items).toHaveLength(0);
  });

  it('詳細が取れる。まだ作品の無い方は見つからない', async () => {
    seedCreator();
    const operator = actorToken('operator', 'operator-creator-5');

    const response = await request(app.getHttpServer())
      .get(`/api/v1/admin/creators/${CREATOR}`)
      .set(auth(operator))
      .expect(200);
    expect(response.body.creator).toMatchObject({ displayName: '千ノ国 太郎', artworkCount: 3 });

    await request(app.getHttpServer())
      .get('/api/v1/admin/creators/33333333-3333-4333-8333-333333333333')
      .set(auth(operator))
      .expect(404);
  });

  /*
    ⚠️ **止める口を置いていない。** 作家さま単位で出品を止める操作は、
       止めたときに何が起きるか（進行中の注文・発行待ちの受取権・精算）を
       決めてから作る。**見る画面のついでに足さない。**
  */
  it('止める口も直す口も無い', async () => {
    seedCreator();
    const operator = actorToken('operator', 'operator-creator-6');
    await request(app.getHttpServer())
      .post(`/api/v1/admin/creators/${CREATOR}/suspend`)
      .set(auth(operator))
      .expect(404);
    await request(app.getHttpServer())
      .delete(`/api/v1/admin/creators/${CREATOR}`)
      .set(auth(operator))
      .expect(404);
  });
});
