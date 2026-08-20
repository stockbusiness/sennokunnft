import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createDevToken, DevTokenVerifier } from '@sengoku/integrations';
import type { Role } from '@sengoku/auth';
import { AppModule } from '../src/app.module';
import { DomainErrorFilter } from '../src/common/domain-error.filter';
import { createRefundWindowResolver } from '../src/settlement/refund-window';
import {
  buildHarness,
  TEST_AUDIENCE,
  TEST_ISSUER,
  TEST_NOW,
  TEST_TOKEN_SECRET,
  type TestHarness,
} from './helpers/doubles';

/**
 * 返金と精算の取り決め（`UD-104` / `UD-119`。決定 2026-08-20）。
 *
 * ⚠️ **この組の主題は 4 つ。**
 *  1. 変更が**オーナーの印＋再認証**でしか通らないこと。返金の受付と
 *     作家さまへのお支払いの**両方**を動かす操作なので、運営の 1 人が
 *     乗っ取られただけで書き換えられてはいけない。
 *  2. 読み取りは `auditor` にも開いていること。返金の条件が見えないと
 *     監査にならない。
 *  3. 未設定が既定値へ化けないこと。決めていないものを「決まっている」
 *     ように見せない。
 *  4. 変更が**過去の記録に効かない**こと。ここが仕様の芯である
 *     （`docs/SETTLEMENT_AND_REFUND.md` §0）。
 */

let app: INestApplication;
let harness: TestHarness;

const PATH = '/api/v1/admin/settlement-settings';

const VALID = {
  refundWindowDays: 14,
  payoutOffsetMonths: 1,
  minimumPayoutAmount: 1000,
  transferFeeBearer: 'creator',
} as const;

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

function ownerToken(): string {
  return actorToken('operator', 'owner-1', { isOwner: true });
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
  it('未認証では読めない', async () => {
    await request(app.getHttpServer()).get(PATH).expect(401);
  });

  it('会員は読めない', async () => {
    await request(app.getHttpServer())
      .get(PATH)
      .set(auth(actorToken('buyer', 'buyer-1')))
      .expect(403);
  });

  it('監査担当は読める（返金の条件が見えないと監査にならない）', async () => {
    await request(app.getHttpServer())
      .get(PATH)
      .set(auth(actorToken('auditor', 'auditor-1')))
      .expect(200);
  });

  it('運営は読める', async () => {
    await request(app.getHttpServer())
      .get(PATH)
      .set(auth(actorToken('operator', 'operator-1')))
      .expect(200);
  });
});

describe('変えられるのはオーナーだけ', () => {
  it('オーナーの印が無い運営は書き換えられない', async () => {
    /*
      ⚠️ **返金の受付と作家さまへのお支払いの両方を動かす。** 運営の 1 人が
         乗っ取られただけで「返金を受け付けない」「支払いを止める」へ
         書き換えられてはいけない。
    */
    await request(app.getHttpServer())
      .put(PATH)
      .set(auth(actorToken('operator', 'operator-2')))
      .send(VALID)
      .expect(403);
  });

  it('監査担当は書き換えられない（読めることと変えられることは別）', async () => {
    await request(app.getHttpServer())
      .put(PATH)
      .set(auth(actorToken('auditor', 'auditor-2')))
      .send(VALID)
      .expect(403);
  });

  it('オーナーでも、ログインから時間が経っていれば断る', async () => {
    /*
      ⚠️ **401 で返る。** 403 だと「権限が無い」と読まれ、ログインし直せば
         通ることが伝わらない。
    */
    await request(app.getHttpServer())
      .put(PATH)
      .set(auth(actorToken('operator', 'owner-old', { isOwner: true, issuedSecondsAgo: 3600 })))
      .send(VALID)
      .expect(401);
  });

  it('オーナーが最近ログインしていれば通る', async () => {
    const response = await request(app.getHttpServer())
      .put(PATH)
      .set(auth(ownerToken()))
      .send({ ...VALID, refundWindowDays: 7 })
      .expect(200);
    expect(response.body).toMatchObject({ refundWindowDays: 7 });
  });
});

describe('未設定を既定値へ化けさせない', () => {
  it('取り決めが無ければ `settings` は null', async () => {
    harness.settlement.clear();
    const response = await request(app.getHttpServer())
      .get(PATH)
      .set(auth(actorToken('operator', 'operator-3')))
      .expect(200);
    expect(response.body).toEqual({ settings: null });
  });

  it('未設定でも、決済そのものは止めない（期限が付かないだけ）', async () => {
    /*
      ⚠️ **入れ忘れが「お支払いが通らない」として購入者に出てはいけない。**
         期限が付かないと購入者都合の返金が通らなくなるが、それは運営が
         気づいて直せる話で、決済を止めるより被害が小さい。
    */
    harness.settlement.clear();
    const resolve = createRefundWindowResolver(harness.settlement, 'production');
    await expect(resolve(TEST_NOW)).resolves.toBeNull();
  });

  it('設定があれば、その日数を足した期限になる', async () => {
    const resolve = createRefundWindowResolver(harness.settlement, 'production');
    const until = await resolve(TEST_NOW);
    expect(until?.getTime()).toBe(TEST_NOW.getTime() + 14 * 86_400_000);
  });
});

describe('受け付けない入力', () => {
  it('返金の日数が精算の猶予を超える組み合わせを断る', async () => {
    /*
      ⚠️ 通すと「支払い済みの注文が返金される」が常態になる。
      ⚠️ **400 で返す。** どちらの値も単独では範囲内で、断る理由は
         「組み合わせが噛み合っていない」——つまり送られた内容の誤り。
         状態の衝突（409）ではないので、やり直せば通る類ではない。
    */
    const response = await request(app.getHttpServer())
      .put(PATH)
      .set(auth(ownerToken()))
      .send({ ...VALID, refundWindowDays: 60, payoutOffsetMonths: 1 })
      .expect(400);
    expect(response.body.error.code).toBe('SETTLEMENT_SETTINGS_INVALID');
  });

  it('範囲外の値を断る', async () => {
    await request(app.getHttpServer())
      .put(PATH)
      .set(auth(ownerToken()))
      .send({ ...VALID, payoutOffsetMonths: 24 })
      .expect(400);
  });

  it('知らない負担者を断る', async () => {
    await request(app.getHttpServer())
      .put(PATH)
      .set(auth(ownerToken()))
      .send({ ...VALID, transferFeeBearer: 'buyer' })
      .expect(400);
  });

  it('欄が欠けていれば断る（部分更新にしない）', async () => {
    /*
      ⚠️ **部分更新を受け付けない。** 返金の日数と精算の猶予は
         互いの組み合わせで妥当性が決まるので、片方だけ差し替えられると
         「送っていない側の古い値」と突き合わせることになる。
    */
    await request(app.getHttpServer())
      .put(PATH)
      .set(auth(ownerToken()))
      .send({ refundWindowDays: 7 })
      .expect(400);
  });

  it('断られたときは、前の値のままにする', async () => {
    await request(app.getHttpServer())
      .put(PATH)
      .set(auth(ownerToken()))
      .send({ ...VALID, refundWindowDays: 60 })
      .expect(400);
    const after = await request(app.getHttpServer())
      .get(PATH)
      .set(auth(actorToken('operator', 'operator-4')))
      .expect(200);
    expect(after.body.settings).toMatchObject({ refundWindowDays: 14 });
  });
});

describe('記録', () => {
  it('前後の値を監査ログへ残す', async () => {
    /*
      ⚠️ **「14 日から 7 日にした」が分からないと、あとで「なぜこの注文は
         返金できたのか」を説明できない。** 取り決めは秘密ではないので、
         値そのものを残してよい。
    */
    await request(app.getHttpServer())
      .put(PATH)
      .set(auth(ownerToken()))
      .send({ ...VALID, refundWindowDays: 7 })
      .expect(200);

    const entry = harness.audit.entries.find((row) => row.action === 'settlement.settings_updated');
    expect(entry).toBeDefined();
    expect(entry?.summary).toMatchObject({
      before: { refundWindowDays: 14 },
      after: { refundWindowDays: 7 },
    });
  });

  it('未設定からの登録は before が null', async () => {
    harness.settlement.clear();
    await request(app.getHttpServer()).put(PATH).set(auth(ownerToken())).send(VALID).expect(200);

    const entry = harness.audit.entries.find((row) => row.action === 'settlement.settings_updated');
    expect(entry?.summary).toMatchObject({ before: null });
  });

  it('断られた変更は記録に残さない（起きていないため）', async () => {
    await request(app.getHttpServer())
      .put(PATH)
      .set(auth(ownerToken()))
      .send({ ...VALID, refundWindowDays: 60 })
      .expect(400);
    expect(harness.audit.entries.some((row) => row.action === 'settlement.settings_updated')).toBe(
      false,
    );
  });
});

describe('変えても過去に効かない', () => {
  it('日数を延ばしても、すでに書き留めた期限は動かない', async () => {
    /*
      ⚠️ **ここが仕様の芯**（`docs/SETTLEMENT_AND_REFUND.md` §0）。
         期限は決済確定の時点で注文へ焼き付ける。設定を変えたときに
         過去の注文の期限まで動くと、精算済みの注文が「まだ返金できる」
         に化ける。
    */
    const resolve = createRefundWindowResolver(harness.settlement, 'production');
    const before = await resolve(TEST_NOW);

    await request(app.getHttpServer())
      .put(PATH)
      .set(auth(ownerToken()))
      .send({ ...VALID, refundWindowDays: 3 })
      .expect(200);

    // 焼き付け済みの値は、設定を変えたあとも同じ。
    expect(before?.getTime()).toBe(TEST_NOW.getTime() + 14 * 86_400_000);
    // これから決済されるぶんだけが新しい日数になる。
    const after = await resolve(TEST_NOW);
    expect(after?.getTime()).toBe(TEST_NOW.getTime() + 3 * 86_400_000);
  });
});
