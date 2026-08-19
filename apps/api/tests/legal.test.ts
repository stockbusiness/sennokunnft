import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createDevToken, DevTokenVerifier } from '@sengoku/integrations';
import type { Role } from '@sengoku/auth';
import { TOKUSHOHO_FIELD_KEYS } from '@sengoku/domain';
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
 * 法務文書（利用規約・プライバシーポリシー・特商法表記）。
 *
 * ⚠️ **この試験の主題は「戻せないこと」。** 公開した版は書き換えられず、
 * 消せず、施行日をさかのぼれない。ここが緩むと、「その注文の時点で
 * どう書いてあったか」が示せなくなる。
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

const FUTURE = '2026-07-01T00:00:00.000Z';
const LATER = '2026-08-01T00:00:00.000Z';

function tokushohoBody(): Record<string, string> {
  return Object.fromEntries(TOKUSHOHO_FIELD_KEYS.map((key) => [key, `内容: ${key}`]));
}

async function saveTermsDraft(token: string, bodyText = '第1条 本規約は…'): Promise<void> {
  await request(app.getHttpServer())
    .put('/api/v1/admin/legal/terms/draft')
    .set(auth(token))
    .send({ title: '利用規約', bodyText })
    .expect(200);
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
  it('未認証では下書きを保存できない', async () => {
    await request(app.getHttpServer())
      .put('/api/v1/admin/legal/terms/draft')
      .send({ title: '利用規約', bodyText: '本文' })
      .expect(401);
  });

  it('会員は下書きを保存できない', async () => {
    await request(app.getHttpServer())
      .put('/api/v1/admin/legal/terms/draft')
      .set(auth(actorToken('buyer', 'buyer-1')))
      .send({ title: '利用規約', bodyText: '本文' })
      .expect(403);
  });

  it('運営スタッフは下書きを保存できる（印は要らない）', async () => {
    await saveTermsDraft(actorToken('operator', 'ops-1'));
  });

  it('閲覧者は下書きを保存できない', async () => {
    await request(app.getHttpServer())
      .put('/api/v1/admin/legal/terms/draft')
      .set(auth(actorToken('auditor', 'aud-1')))
      .send({ title: '利用規約', bodyText: '本文' })
      .expect(403);
  });

  it('閲覧者も一覧は見られる（過去の版を確かめるのは監査の仕事）', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/legal/terms')
      .set(auth(actorToken('auditor', 'aud-2')))
      .expect(200);
  });

  /*
    ⚠️ **公開はオーナーだけ。** 取り消せない操作なので、書く人と決める人を
       分ける。ここが緩むと、運営の 1 人が乗っ取られただけで、
       購入者への約束を書き替えられる。
  */
  it('印の無い運営は公開できない', async () => {
    const token = actorToken('operator', 'ops-2');
    await saveTermsDraft(token);
    await request(app.getHttpServer())
      .post('/api/v1/admin/legal/terms/publish')
      .set(auth(token))
      .send({ effectiveFrom: FUTURE })
      .expect(403);
  });

  it('印を持つ運営は公開できる', async () => {
    const token = actorToken('operator', 'owner-1', { isOwner: true });
    await saveTermsDraft(token);
    const response = await request(app.getHttpServer())
      .post('/api/v1/admin/legal/terms/publish')
      .set(auth(token))
      .send({ effectiveFrom: FUTURE })
      .expect(201);
    expect(response.body).toMatchObject({ status: 'published', version: 1 });
  });
});

describe('公開した版は戻せない', () => {
  it('公開後に下書きを保存しても、公開済みの版は書き換わらない', async () => {
    const token = actorToken('operator', 'owner-2', { isOwner: true });
    await saveTermsDraft(token, '最初の本文');
    await request(app.getHttpServer())
      .post('/api/v1/admin/legal/terms/publish')
      .set(auth(token))
      .send({ effectiveFrom: FUTURE })
      .expect(201);

    // 次に保存したものは、新しい下書きになる。
    await saveTermsDraft(token, 'あとから直した本文');

    const list = await request(app.getHttpServer())
      .get('/api/v1/admin/legal/terms')
      .set(auth(token))
      .expect(200);

    const versions = list.body.versions as { version: number; status: string; bodyText: string }[];
    expect(versions).toHaveLength(2);
    const first = versions.find((v) => v.version === 1);
    expect(first?.status).toBe('published');
    expect(first?.bodyText).toBe('最初の本文');
    expect(versions.find((v) => v.version === 2)?.status).toBe('draft');
  });

  it('削除の口が無い', async () => {
    const token = actorToken('operator', 'owner-3', { isOwner: true });
    await saveTermsDraft(token);
    await request(app.getHttpServer())
      .delete('/api/v1/admin/legal/terms')
      .set(auth(token))
      .expect(404);
  });
});

describe('施行日', () => {
  it('過去の日付では公開できない', async () => {
    const token = actorToken('operator', 'owner-4', { isOwner: true });
    await saveTermsDraft(token);
    const response = await request(app.getHttpServer())
      .post('/api/v1/admin/legal/terms/publish')
      .set(auth(token))
      .send({ effectiveFrom: '2026-01-01T00:00:00.000Z' })
      .expect(400);
    expect(response.body.error.code).toBe('LEGAL_EFFECTIVE_DATE_INVALID');
  });

  /*
    ⚠️ **同じ日時で 2 つ施行しない。** どちらが有効かが並び順まかせになる。
       DB 側にも部分一意索引を置いてある。
  */
  it('施行中の版の次は、番号が進んだ新しい版になる', async () => {
    const token = actorToken('operator', 'owner-5', { isOwner: true });
    await saveTermsDraft(token, '第1版');
    await request(app.getHttpServer())
      .post('/api/v1/admin/legal/terms/publish')
      .set(auth(token))
      .send({ effectiveFrom: LATER })
      .expect(201);

    // 施行日をまたぐ。
    harness.clock.set(new Date('2026-08-02T00:00:00.000Z'));
    await saveTermsDraft(token, '第2版');
    const response = await request(app.getHttpServer())
      .post('/api/v1/admin/legal/terms/publish')
      .set(auth(token))
      .send({ effectiveFrom: '2026-08-03T00:00:00.000Z' })
      .expect(201);
    expect(response.body.version).toBe(2);

    const shown = await request(app.getHttpServer()).get('/api/v1/legal/terms').expect(200);
    expect(shown.body.version.bodyText).toBe('第1版');
  });

  /*
    ⚠️ **公開済み＝いま有効ではない。** 予約公開があるので、両者を
       同じに扱うと、まだ効いていない条件が公開ページに出る。
  */
  it('施行日が来ていない版は公開ページに出ない', async () => {
    const token = actorToken('operator', 'owner-6', { isOwner: true });
    await saveTermsDraft(token, '未来から効く本文');
    await request(app.getHttpServer())
      .post('/api/v1/admin/legal/terms/publish')
      .set(auth(token))
      .send({ effectiveFrom: LATER })
      .expect(201);

    const before = await request(app.getHttpServer()).get('/api/v1/legal/terms').expect(200);
    expect(before.body.version).toBeNull();

    harness.clock.set(new Date('2026-08-02T00:00:00.000Z'));
    const after = await request(app.getHttpServer()).get('/api/v1/legal/terms').expect(200);
    expect(after.body.version).toMatchObject({ bodyText: '未来から効く本文', isEffective: true });
  });
});

describe('公開ページ', () => {
  it('認証なしで読める', async () => {
    await request(app.getHttpServer()).get('/api/v1/legal/privacy').expect(200);
  });

  it('下書きは出ない', async () => {
    await saveTermsDraft(actorToken('operator', 'ops-3'));
    const response = await request(app.getHttpServer()).get('/api/v1/legal/terms').expect(200);
    expect(response.body.version).toBeNull();
  });

  it('知らない種類は断る', async () => {
    await request(app.getHttpServer()).get('/api/v1/legal/unknown').expect(400);
  });
});

describe('HTML を受け付けない', () => {
  it('本文に HTML があれば断る', async () => {
    await request(app.getHttpServer())
      .put('/api/v1/admin/legal/terms/draft')
      .set(auth(actorToken('operator', 'ops-4')))
      .send({ title: '利用規約', bodyText: '<script>alert(1)</script>' })
      .expect(400);
  });

  it('表題に HTML があれば断る', async () => {
    await request(app.getHttpServer())
      .put('/api/v1/admin/legal/terms/draft')
      .set(auth(actorToken('operator', 'ops-5')))
      .send({ title: '<b>利用規約</b>', bodyText: '本文' })
      .expect(400);
  });
});

describe('特商法の表記', () => {
  it('書きかけでも下書きは保存できる', async () => {
    const fields = { ...tokushohoBody(), phoneNumber: '' };
    await request(app.getHttpServer())
      .put('/api/v1/admin/legal/tokushoho/draft')
      .set(auth(actorToken('operator', 'ops-6')))
      .send({ title: '特定商取引法に基づく表記', tokushoho: fields })
      .expect(200);
  });

  it('欠けたままでは公開できない（表示義務のある項目）', async () => {
    const token = actorToken('operator', 'owner-7', { isOwner: true });
    const fields = { ...tokushohoBody(), phoneNumber: '' };
    await request(app.getHttpServer())
      .put('/api/v1/admin/legal/tokushoho/draft')
      .set(auth(token))
      .send({ title: '特定商取引法に基づく表記', tokushoho: fields })
      .expect(200);

    const response = await request(app.getHttpServer())
      .post('/api/v1/admin/legal/tokushoho/publish')
      .set(auth(token))
      .send({ effectiveFrom: FUTURE })
      .expect(409);
    expect(response.body.error.code).toBe('LEGAL_DOCUMENT_INCOMPLETE');
  });

  it('どこが欠けているかを画面へ返す', async () => {
    const fields = { ...tokushohoBody(), phoneNumber: '', returnPolicy: '' };
    const response = await request(app.getHttpServer())
      .put('/api/v1/admin/legal/tokushoho/draft')
      .set(auth(actorToken('operator', 'ops-7')))
      .send({ title: '特定商取引法に基づく表記', tokushoho: fields })
      .expect(200);
    expect(response.body.missingFields).toEqual(['phoneNumber', 'returnPolicy']);
  });

  it('埋まっていれば公開できる', async () => {
    const token = actorToken('operator', 'owner-8', { isOwner: true });
    await request(app.getHttpServer())
      .put('/api/v1/admin/legal/tokushoho/draft')
      .set(auth(token))
      .send({ title: '特定商取引法に基づく表記', tokushoho: tokushohoBody() })
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/v1/admin/legal/tokushoho/publish')
      .set(auth(token))
      .send({ effectiveFrom: FUTURE })
      .expect(201);
  });
});

describe('操作の記録', () => {
  it('公開を監査ログへ残す。⚠️ 本文は入れない', async () => {
    const token = actorToken('operator', 'owner-9', { isOwner: true });
    await saveTermsDraft(token, '記録に残らないはずの本文');
    await request(app.getHttpServer())
      .post('/api/v1/admin/legal/terms/publish')
      .set(auth(token))
      .send({ effectiveFrom: FUTURE })
      .expect(201);

    const entries = harness.audit.entries.filter((entry) => entry.action === 'legal.published');
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries[0]?.summary)).not.toContain('記録に残らないはずの本文');
    expect(entries[0]?.summary).toMatchObject({ kind: 'terms', version: 1 });
  });
});

/**
 * 規約への同意（`UD-126` 決定 2026-08-19）。
 *
 * ⚠️ **この組の主題は「締め出しを作らないこと」と「読んでいない条件に
 * 同意させないこと」。**
 */
describe('規約への同意', () => {
  async function publishTerms(
    token: string,
    body: string,
    options: { readonly requiresReconsent?: boolean } = {},
  ): Promise<string> {
    await saveTermsDraft(token, body);
    const response = await request(app.getHttpServer())
      .post('/api/v1/admin/legal/terms/publish')
      .set(auth(token))
      .send({
        effectiveFrom: new Date(harness.clock.now().getTime() + 1_000).toISOString(),
        ...(options.requiresReconsent === undefined
          ? {}
          : { requiresReconsent: options.requiresReconsent }),
      })
      .expect(201);
    // 施行日をまたぐ。
    harness.clock.set(new Date(harness.clock.now().getTime() + 60_000));
    return response.body.id as string;
  }

  it('未認証では同意の状態を見られない', async () => {
    await request(app.getHttpServer()).get('/api/v1/legal-consent').expect(401);
  });

  /*
    ⚠️ **いちばん大事な試験。** 規約が未公開のときに同意を求めると、
       立ち上げ時に誰もログインできなくなる。規約を公開できるのは
       管理画面へ入れる人で、その人が入れなければ永久に公開できない。
  */
  it('規約が未公開なら同意を求めない（締め出しを作らない）', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/legal-consent')
      .set(auth(actorToken('buyer', 'buyer-consent-1')))
      .expect(200);
    expect(response.body).toMatchObject({ required: false, reason: 'no_document', version: null });
  });

  it('公開されていれば、一度も同意していない人に求める', async () => {
    await publishTerms(actorToken('operator', 'owner-c1', { isOwner: true }), '第1版の本文');

    const response = await request(app.getHttpServer())
      .get('/api/v1/legal-consent')
      .set(auth(actorToken('buyer', 'buyer-consent-2')))
      .expect(200);
    expect(response.body.required).toBe(true);
    expect(response.body.reason).toBe('never_consented');
    expect(response.body.version.bodyText).toBe('第1版の本文');
  });

  it('同意すると、次からは求められない', async () => {
    const versionId = await publishTerms(
      actorToken('operator', 'owner-c2', { isOwner: true }),
      '第1版の本文',
    );
    const buyer = actorToken('buyer', 'buyer-consent-3');

    const recorded = await request(app.getHttpServer())
      .post('/api/v1/legal-consent')
      .set(auth(buyer))
      .send({ versionId })
      .expect(201);
    expect(recorded.body).toMatchObject({ required: false, consentedVersion: 1 });

    const again = await request(app.getHttpServer())
      .get('/api/v1/legal-consent')
      .set(auth(buyer))
      .expect(200);
    expect(again.body).toMatchObject({ required: false, reason: 'already_consented' });
  });

  /*
    ⚠️ **読んでいない条件に同意させない。** 画面が見ていた版と、いま
       施行中の版が違えば断る。黙って差し替えると、利用者が読んだものと
       記録が食い違う。
  */
  it('画面が見ていた版と食い違えば断る', async () => {
    await publishTerms(actorToken('operator', 'owner-c3', { isOwner: true }), '第1版の本文');
    const response = await request(app.getHttpServer())
      .post('/api/v1/legal-consent')
      .set(auth(actorToken('buyer', 'buyer-consent-4')))
      .send({ versionId: 'まったく別の版' })
      .expect(409);
    expect(response.body.error.code).toBe('LEGAL_CONSENT_VERSION_MISMATCH');
  });

  it('二度押しても記録は増えない', async () => {
    const versionId = await publishTerms(
      actorToken('operator', 'owner-c4', { isOwner: true }),
      '第1版の本文',
    );
    const buyer = actorToken('buyer', 'buyer-consent-5');
    for (const _ of [1, 2, 3]) {
      await request(app.getHttpServer())
        .post('/api/v1/legal-consent')
        .set(auth(buyer))
        .send({ versionId })
        .expect(201);
    }
    const entries = harness.audit.entries.filter((entry) => entry.action === 'legal.consented');
    // 監査ログは押した回数だけ残る（操作の記録なので）。
    expect(entries).toHaveLength(3);
    // 同意そのものは 1 件のまま。
    const latest = await harness.legalConsents.findLatestConsent(
      'account-buyer-consent-5',
      'terms',
    );
    expect(latest?.version).toBe(1);
  });

  /*
    ⚠️ **誤字の修正で全員を止めない。** 止めると、同意の画面が
       「とりあえず押すもの」になり、同意という記録の意味が薄れる。
  */
  it('改定しても、再同意の印が無ければ求めない', async () => {
    const owner = actorToken('operator', 'owner-c5', { isOwner: true });
    const versionId = await publishTerms(owner, '第1版の本文');
    const buyer = actorToken('buyer', 'buyer-consent-6');
    await request(app.getHttpServer())
      .post('/api/v1/legal-consent')
      .set(auth(buyer))
      .send({ versionId })
      .expect(201);

    await publishTerms(owner, '第2版の本文（誤字を直しただけ）');

    const response = await request(app.getHttpServer())
      .get('/api/v1/legal-consent')
      .set(auth(buyer))
      .expect(200);
    expect(response.body).toMatchObject({ required: false, reason: 'already_consented' });
  });

  it('再同意の印を立てて公開すると、次に確かめたときに求められる', async () => {
    const owner = actorToken('operator', 'owner-c6', { isOwner: true });
    const versionId = await publishTerms(owner, '第1版の本文');
    const buyer = actorToken('buyer', 'buyer-consent-7');
    await request(app.getHttpServer())
      .post('/api/v1/legal-consent')
      .set(auth(buyer))
      .send({ versionId })
      .expect(201);

    await publishTerms(owner, '第2版の本文（実質的な変更）', { requiresReconsent: true });

    const response = await request(app.getHttpServer())
      .get('/api/v1/legal-consent')
      .set(auth(buyer))
      .expect(200);
    expect(response.body.required).toBe(true);
    expect(response.body.reason).toBe('reconsent');
    expect(response.body.consentedVersion).toBe(1);
  });

  it('再同意の印は監査ログに残る', async () => {
    await publishTerms(actorToken('operator', 'owner-c7', { isOwner: true }), '本文', {
      requiresReconsent: true,
    });
    const entry = harness.audit.entries.find((item) => item.action === 'legal.published');
    expect(entry?.summary).toMatchObject({ requiresReconsent: true });
  });
});
