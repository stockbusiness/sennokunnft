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
 *  4. **お振込先を、他人が差し替えられないこと**（P1-3）
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

  /*
    ⚠️ **この組でいちばん大事な 1 本。**

    作家さまは月の途中で見込みを見て、翌月に締めた額を見る。**その 2 つが
    ずれると「話が違う」になる。** ずれる原因は、見込みを別の式で出す
    ことである（見込み用に手早く書いた合計と、締めのときの正しい合計）。

    そうならないよう、見込みは `PayoutService.estimateFor` を通し、締める
    ときと**同じ `buildFor`** を呼んでいる。ここでは月をまたいで、
    6 月半ばに見た見込みと、7 月に締めた実額が一致することを確かめる。

    ⚠️ **数字を直に書かない。** 見込み側の数字を期待値に書くと、両方が
       同じ間違いをしたときに気づけない。見込みと実額を**突き合わせる**。
  */
  it('月をまたいでも、見込みと締めた実額がずれない', async () => {
    const creator = actorToken('operator', 'user-operator');
    // ⚠️ 6/10 のお買い上げ。返金の窓（14 日）は 6/24 に閉じる。
    harness.payouts.candidates = [
      {
        orderId: 'order-june-1',
        orderNumber: 'SNK-0601',
        creatorAccountId: 'account-user-operator',
        artworkTitleSnapshot: '朝霧の里',
        paidAt: new Date('2026-06-10T00:00:00.000Z'),
        grossAmount: 12000,
        feeRateBps: 2000,
        feeAmount: 2400,
        netAmount: 9600,
        refundableUntil: new Date('2026-06-24T00:00:00.000Z'),
      },
    ];

    // --- 6 月半ば。作家さまが見込みを見る。 ---
    harness.clock.set(new Date('2026-06-15T00:00:00.000Z'));
    const estimate = await request(app.getHttpServer())
      .get('/api/v1/creator/earnings')
      .set(auth(creator))
      .expect(200);
    expect(estimate.body.current.state).toBe('estimate');
    expect(estimate.body.current.periodKey).toBe('2026-06');
    /*
      ⚠️ **空同士を突き合わせていないことを確かめる。** 両方 0 なら、
         この試験は何も見ていないのに通ってしまう。
    */
    expect(estimate.body.current.grossAmount).toBe(12000);
    expect(estimate.body.current.netAmount).toBe(9600);

    // --- 7 月。運営が 6 月を締める。 ---
    harness.clock.set(new Date('2026-07-20T00:00:00.000Z'));
    await request(app.getHttpServer())
      .post('/api/v1/admin/payouts/close')
      .set(auth(actorToken('operator', 'closer-1')))
      .send({ periodKey: '2026-06' })
      .expect(201);

    const after = await request(app.getHttpServer())
      .get('/api/v1/creator/earnings')
      .set(auth(creator))
      .expect(200);
    const closed = after.body.history.find(
      (row: { periodKey: string }) => row.periodKey === '2026-06',
    );

    // ⚠️ 見込みで見えていた額が、そのまま締めた額になっている。
    expect(closed).toBeDefined();
    expect(closed.grossAmount).toBe(estimate.body.current.grossAmount);
    expect(closed.feeAmount).toBe(estimate.body.current.feeAmount);
    expect(closed.netAmount).toBe(estimate.body.current.netAmount);
    // ⚠️ 「見込み」の顔のまま残さない。締めたことが分かる。
    expect(closed.state).not.toBe('estimate');
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
  it('お振込先が未登録なら、そう出る', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/creator/profile/detail')
      .set(auth(actorToken('operator')))
      .expect(200);

    const payout = response.body.setup.find((row: { key: string }) => row.key === 'payout_account');
    expect(payout.done).toBe(false);
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

/**
 * お振込先（P1-3・`UD-124` 決定 2026-08-21）。
 *
 * ⚠️ **この組の主題は 3 つ。**
 *  1. **他人の支払先を差し替えられないこと**——この仕組みでいちばん実入りの
 *     ある攻撃である
 *  2. **口座番号が、応答にも記録にも平文で出ないこと**
 *  3. **差し替えたらご本人へ知らせが飛ぶこと**——気づけるのは本人だけ
 */
describe('お振込先', () => {
  const ACCOUNT = {
    bankName: '千ノ国銀行',
    branchName: '本店',
    accountType: 'ordinary' as const,
    accountNumber: '1234567',
    accountHolderKana: 'センゴク タロウ',
  };

  function noticesFor(): typeof harness.notifications.rows {
    return harness.notifications.rows.filter(
      (row) => row.record.eventType === 'payout_account.changed',
    );
  }

  it('未登録なら null で返る', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/creator/payout-account')
      .set(auth(actorToken('operator')))
      .expect(200);
    expect(response.body.account).toBeNull();
  });

  it('登録して読み戻せる', async () => {
    const token = actorToken('operator');
    await request(app.getHttpServer())
      .put('/api/v1/creator/payout-account')
      .set(auth(token))
      .send(ACCOUNT)
      .expect(200);

    const response = await request(app.getHttpServer())
      .get('/api/v1/creator/payout-account')
      .set(auth(token))
      .expect(200);
    expect(response.body.account).toMatchObject({
      bankName: '千ノ国銀行',
      branchName: '本店',
      accountType: 'ordinary',
      accountHolderKana: 'センゴク タロウ',
    });
  });

  /*
    ⚠️ **この組でいちばん大事な 1 本。** 番号が応答に出ると、画面を開く
       たびに経路へ流れる。返すのは伏せた表記まで。
  */
  it('口座番号そのものは応答に出ない', async () => {
    const token = actorToken('operator');
    await request(app.getHttpServer())
      .put('/api/v1/creator/payout-account')
      .set(auth(token))
      .send(ACCOUNT)
      .expect(200);

    const response = await request(app.getHttpServer())
      .get('/api/v1/creator/payout-account')
      .set(auth(token))
      .expect(200);
    expect(JSON.stringify(response.body)).not.toContain('1234567');
    expect(response.body.account.maskedAccountNumber).toBe('***4567');
  });

  /*
    ⚠️ **記録に番号が残れば、包んだ意味が無くなる。**
  */
  it('監査ログに口座番号が残らない', async () => {
    await request(app.getHttpServer())
      .put('/api/v1/creator/payout-account')
      .set(auth(actorToken('operator')))
      .send(ACCOUNT)
      .expect(200);

    const recorded = harness.audit.entries.filter((row) => row.action === 'payout_account.saved');
    expect(recorded).toHaveLength(1);
    expect(JSON.stringify(recorded[0])).not.toContain('1234567');
  });

  /*
    ⚠️ **保管も包んでおく。** 平文で置く逃げ道があると、鍵の設定を忘れた
       配備で静かに平文が溜まる。
  */
  it('保管されている値も平文ではない', async () => {
    const token = actorToken('operator');
    await request(app.getHttpServer())
      .put('/api/v1/creator/payout-account')
      .set(auth(token))
      .send(ACCOUNT)
      .expect(200);

    const stored = [...harness.payoutAccounts.rows.values()];
    expect(JSON.stringify(stored)).not.toContain('1234567');
    // ⚠️ 末尾 4 桁は伏せた表記に残る（どの口座かを本人と確かめるため）。
    expect(stored[0]?.maskedAccountNumber).toBe('***4567');
  });

  /*
    ⚠️ **初めての登録に「変更されました」と届かせない。** 身に覚えのない
       知らせになる。
  */
  it('初めての登録では知らせない', async () => {
    await request(app.getHttpServer())
      .put('/api/v1/creator/payout-account')
      .set(auth(actorToken('operator')))
      .send(ACCOUNT)
      .expect(200);
    expect(noticesFor()).toHaveLength(0);
  });

  /*
    ⚠️ **差し替えたら必ず知らせる。** お金の行き先が変わる操作で、
       気づけるのは本人だけである。
  */
  it('差し替えたらご本人へ知らせる', async () => {
    const token = actorToken('operator');
    await request(app.getHttpServer())
      .put('/api/v1/creator/payout-account')
      .set(auth(token))
      .send(ACCOUNT)
      .expect(200);

    harness.clock.set(new Date(TEST_NOW.getTime() + 60_000));
    await request(app.getHttpServer())
      .put('/api/v1/creator/payout-account')
      .set(auth(token))
      .send({ ...ACCOUNT, accountNumber: '7654321' })
      .expect(200);

    const notices = noticesFor();
    expect(notices).toHaveLength(1);
    expect(notices[0]?.record.accountId).toBe('account-user-operator');
    /*
      ⚠️ **新しい口座の情報を載せない。** 載せると、乗っ取った側が
         このメールを見れば済むことになる。
    */
    expect(notices[0]?.record.renderedBody).not.toContain('7654321');
  });

  /*
    ⚠️ **2 回目の差し替えも知らせる。** 対象をアカウントだけにすると
       重複として捨てられ、**乗っ取りの 2 回目が知らされない**。
  */
  it('2 回差し替えたら、2 回とも知らせる', async () => {
    const token = actorToken('operator');
    await request(app.getHttpServer())
      .put('/api/v1/creator/payout-account')
      .set(auth(token))
      .send(ACCOUNT)
      .expect(200);

    for (const [index, accountNumber] of ['7654321', '1111222'].entries()) {
      harness.clock.set(new Date(TEST_NOW.getTime() + 60_000 * (index + 1)));
      await request(app.getHttpServer())
        .put('/api/v1/creator/payout-account')
        .set(auth(token))
        .send({ ...ACCOUNT, accountNumber })
        .expect(200);
    }
    expect(noticesFor()).toHaveLength(2);
  });

  /*
    ⚠️ **誰の分かを受け取る口が無い。** 受け取れる形にすると、そこが
       他人の支払先を差し替える道になる。
  */
  it('問い合わせで別のアカウントを指定しても、自分の分が変わる', async () => {
    const other = 'aa11bb22-0000-4000-8000-000000000009';
    await request(app.getHttpServer())
      .put(`/api/v1/creator/payout-account?creatorAccountId=${other}&accountId=${other}`)
      .set(auth(actorToken('operator')))
      .send(ACCOUNT)
      .expect(200);

    expect(harness.payoutAccounts.rows.has(other)).toBe(false);
    expect(harness.payoutAccounts.rows.has('account-user-operator')).toBe(true);
  });

  it('未認証では登録できない', async () => {
    await request(app.getHttpServer())
      .put('/api/v1/creator/payout-account')
      .send(ACCOUNT)
      .expect(401);
  });

  /*
    ⚠️ **どの項目がどう悪かったかを断定しない。** 直しに行ける場所だけを
       伝える（名義がカナであることは、はっきり書く）。
  */
  it('漢字の名義は断る', async () => {
    const response = await request(app.getHttpServer())
      .put('/api/v1/creator/payout-account')
      .set(auth(actorToken('operator')))
      .send({ ...ACCOUNT, accountHolderKana: '戦国 太郎' })
      .expect(422);
    expect(response.body.error.code).toBe('PAYOUT_ACCOUNT_INVALID');
    expect(response.body.error.message).toContain('カタカナ');
  });

  it('登録すると、ご準備の状況が「済」になる', async () => {
    const token = actorToken('operator');
    await request(app.getHttpServer())
      .put('/api/v1/creator/payout-account')
      .set(auth(token))
      .send(ACCOUNT)
      .expect(200);

    const response = await request(app.getHttpServer())
      .get('/api/v1/creator/profile/detail')
      .set(auth(token))
      .expect(200);
    const payout = response.body.setup.find((row: { key: string }) => row.key === 'payout_account');
    expect(payout.done).toBe(true);
  });
});
