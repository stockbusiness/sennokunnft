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
 * 作家さま運営（実運営 指示書 P1-2）。
 *
 * ⚠️ **この組の主題は 4 つ。**
 *  1. **他人の売上が見えないこと。** 誰の分かを指定する口が無い
 *  2. **CSV に買った方の情報が入らないこと**
 *  3. **見込みが「まだ締めていない」と分かること**
 *  4. **お振込先が「準備中」と正直に出ること**（P1-3）
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
    await request(app.getHttpServer()).get('/api/v1/creator/earnings').expect(401);
  });

  /*
    ⚠️ **ここでは「買う人」と「売る人」は同じロールである**（`UD-806`）。
       会員なら誰でも出品できるので、`buyer` を締め出すと**作家さま本人が
       自分の売上を見られなくなる**。一度も売っていない方には空が返るだけで、
       他人の分は指定しようが無い（下の組で確かめる）。
  */
  it.each([
    ['会員', 'buyer'],
    ['運営', 'operator'],
  ] as const)('%s は自分の売上を見られる', async (_label, role) => {
    await request(app.getHttpServer())
      .get('/api/v1/creator/earnings')
      .set(auth(actorToken(role)))
      .expect(200);
  });

  /*
    ⚠️ **閲覧者には渡さない。** 監査は「運営が何をしたか」を見る仕事で、
       自分名義の商いを持たない。作家さまへの支払いは `payout.view` で見る。
  */
  it('閲覧者は見られない', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/creator/earnings')
      .set(auth(actorToken('auditor')))
      .expect(403);
  });
});

describe('他人の売上を覗けない', () => {
  /*
    ⚠️ **売上はその方の商いの中身そのもの。** 誰の分かを指定できる口が
       あってはいけない。問い合わせを足しても無視されることを確かめる。
  */
  it('問い合わせで別のアカウントを指定しても、自分の分が返る', async () => {
    const other = 'aa11bb22-0000-4000-8000-000000000009';
    const response = await request(app.getHttpServer())
      .get(`/api/v1/creator/earnings?creatorAccountId=${other}&accountId=${other}`)
      .set(auth(actorToken('operator')))
      .expect(200);

    // ⚠️ 応答にほかのアカウントの識別子が現れない。
    expect(JSON.stringify(response.body)).not.toContain(other);
  });

  /*
    ⚠️ **運営向けの「作家さまの売上を見る」口をここへ足さない。**
       必要なら `/api/v1/admin/payouts` を使う。
  */
  it.each([
    ['ほかの方の売上', '/api/v1/creator/earnings/aa11bb22-0000-4000-8000-000000000009'],
    ['ほかの方の明細', '/api/v1/creator/earnings/detail/aa11bb22-0000-4000-8000-000000000009'],
  ])('%s を見る口は存在しない', async (_label, path) => {
    await request(app.getHttpServer())
      .get(path)
      .set(auth(actorToken('operator')))
      .expect(404);
  });
});

describe('売上のまとめ', () => {
  /*
    ⚠️ **「まだ締めていない」ことが分かる。** 確定した額と同じ顔を
       させない。
  */
  it('進行中の期間は「見込み」として返る', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/creator/earnings')
      .set(auth(actorToken('operator')))
      .expect(200);
    expect(response.body.current.state).toBe('estimate');
  });

  /*
    ⚠️ **0 円の振込予定を出さない。** 期待させておいて何も起きない。
  */
  it('売上が無ければ、次のお振込は無い', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/creator/earnings')
      .set(auth(actorToken('operator')))
      .expect(200);
    expect(response.body.nextPayout).toBeNull();
  });

  it('売上が無くても 0 で返る（「取得できない」にしない）', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/creator/earnings')
      .set(auth(actorToken('operator')))
      .expect(200);
    expect(response.body.current.grossAmount).toBe(0);
    expect(response.body.byArtwork).toEqual([]);
    expect(response.body.history).toEqual([]);
  });
});

describe('CSV', () => {
  /*
    ⚠️ **買った方の情報を 1 つも入れない。** 明細は作家さまの手元へ
       落ちて、表計算やメールに渡っていく。
  */
  it('見出しに買った方の情報が無い', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/creator/earnings/csv')
      .set(auth(actorToken('operator')))
      .expect(200);

    for (const forbidden of ['氏名', 'メール', '住所', '電話', 'お客']) {
      expect(response.text).not.toContain(forbidden);
    }
    expect(response.text).toContain('注文番号');
  });

  /*
    ⚠️ **BOM を付ける。** 付けないと Excel が UTF-8 と判断せず、
       作品名が文字化けする——開いた作家さまには、こちらの不具合に見える。
  */
  it('BOM が付く（Excel の文字化けを避ける）', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/creator/earnings/csv')
      .set(auth(actorToken('operator')))
      .expect(200);
    expect(response.text.startsWith('﻿')).toBe(true);
  });

  it('ダウンロードとして返る', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/creator/earnings/csv')
      .set(auth(actorToken('operator')))
      .expect(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toContain('attachment');
  });

  it('閲覧者は受け取れない', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/creator/earnings/csv')
      .set(auth(actorToken('auditor')))
      .expect(403);
  });
});

describe('プロフィール', () => {
  it('未登録でも開ける', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/creator/profile/detail')
      .set(auth(actorToken('operator')))
      .expect(200);
    expect(response.body.shopName).toBeNull();
    expect(response.body.links).toEqual([]);
  });

  it('保存して読み戻せる', async () => {
    await request(app.getHttpServer())
      .put('/api/v1/creator/profile/detail')
      .set(auth(actorToken('operator')))
      .send({
        shopName: '桜屋',
        bio: '日本画を描いています。',
        links: [{ label: 'ホームページ', url: 'https://example.test' }],
        invoiceNumber: 'T1234567890123',
      })
      .expect(200);

    const response = await request(app.getHttpServer())
      .get('/api/v1/creator/profile/detail')
      .set(auth(actorToken('operator')))
      .expect(200);
    expect(response.body.shopName).toBe('桜屋');
    expect(response.body.invoiceNumber).toBe('T1234567890123');
  });

  /*
    ⚠️ **消して保存しない。断る。** 消すと、書いた本人には消えたことが
       分からない。
  */
  it('HTML が混じった紹介文は断る', async () => {
    await request(app.getHttpServer())
      .put('/api/v1/creator/profile/detail')
      .set(auth(actorToken('operator')))
      .send({ shopName: null, bio: '<script>alert(1)</script>', links: [], invoiceNumber: null })
      .expect(422);
  });

  it('https でないリンクは断る', async () => {
    await request(app.getHttpServer())
      .put('/api/v1/creator/profile/detail')
      .set(auth(actorToken('operator')))
      .send({
        shopName: null,
        bio: null,
        links: [{ label: 'X', url: 'http://example.test' }],
        invoiceNumber: null,
      })
      .expect(422);
  });

  it('形の違うインボイス番号は断る', async () => {
    await request(app.getHttpServer())
      .put('/api/v1/creator/profile/detail')
      .set(auth(actorToken('operator')))
      .send({ shopName: null, bio: null, links: [], invoiceNumber: '1234567890123' })
      .expect(422);
  });

  /*
    ⚠️ **本文を監査ログへ写さない。** 紹介文は作家さまの文章で、
       2 か所に増やすと消せない場所が 2 つになる。
  */
  it('紹介文は監査ログへ写らない', async () => {
    const bio = '祖父から受け継いだ画法で描いています。';
    await request(app.getHttpServer())
      .put('/api/v1/creator/profile/detail')
      .set(auth(actorToken('operator')))
      .send({ shopName: null, bio, links: [], invoiceNumber: null })
      .expect(200);

    const recorded = harness.audit.entries.filter((row) => row.action === 'creator.profile_saved');
    expect(recorded).toHaveLength(1);
    expect(JSON.stringify(recorded[0])).not.toContain(bio);
  });
});

describe('売る準備', () => {
  /*
    ⚠️ **お振込先を預かる仕組みは、まだこの中に無い**（P1-3）。
       あるふりをしない。
  */
  it('お振込先は「準備中」と出る', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/creator/profile/detail')
      .set(auth(actorToken('operator')))
      .expect(200);

    const payout = response.body.setup.find((row: { key: string }) => row.key === 'payout_account');
    expect(payout.done).toBe(false);
    expect(payout.detail).toContain('準備中');
  });

  /*
    ⚠️ **お振込先を登録する口を作っていない**（P1-3）。
  */
  it('お振込先を登録する口は存在しない', async () => {
    await request(app.getHttpServer())
      .put('/api/v1/creator/payout-account')
      .set(auth(actorToken('operator')))
      .send({ bankName: 'テスト銀行' })
      .expect(404);
  });

  /*
    ⚠️ **免税事業者もいる。** インボイスが無いことは不備ではない。
  */
  it('インボイスだけは必須ではない', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/creator/profile/detail')
      .set(auth(actorToken('operator')))
      .expect(200);
    const invoice = response.body.setup.find(
      (row: { key: string }) => row.key === 'invoice_number',
    );
    expect(invoice.required).toBe(false);
  });

  /*
    ⚠️ **同意を確かめられない配備では「未同意」。** 分からないことを
       「済み」に倒すと、同意を取らないまま売り始められる。
  */
  it('販売規約は、確かめられなければ「未同意」', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/creator/profile/detail')
      .set(auth(actorToken('operator')))
      .expect(200);
    const terms = response.body.setup.find(
      (row: { key: string }) => row.key === 'sales_terms_accepted',
    );
    expect(terms.done).toBe(false);
  });
});

describe('作品審査の口が無いこと（`UD-102` と衝突・決定待ち）', () => {
  /*
    ⚠️ **審査という状態が、この仕組みにはまだ無い。** 出品者が自分で
       公開する（`UD-102`）。口だけ先に作ると、状態の無い申請が溜まる。
  */
  it.each([
    ['審査へ出す', '/api/v1/creator/artworks/aa11bb22-0000-4000-8000-000000000001/submit'],
    ['審査を取り下げる', '/api/v1/creator/artworks/aa11bb22-0000-4000-8000-000000000001/withdraw'],
  ])('%s 口は存在しない', async (_label, path) => {
    await request(app.getHttpServer())
      .post(path)
      .set(auth(actorToken('operator')))
      .expect(404);
  });
});
