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
 * 作家さまの表示名（決定 2026-08-20「屋号・ペンネームを許す／重複を許さない」）。
 *
 * ⚠️ **この組の主題は 4 つ。**
 *  1. **自分の分しか触れないこと。** 誰の分かを本文でも URL でも受け取らない。
 *     受け取れる形にすると、そこが他人の名前を書き換える道になる。
 *  2. **同じに見える名前を 2 人が名乗れないこと。** 全角・半角、大文字・小文字、
 *     空白の有無で抜けられたら、重複を禁じた意味が無い。
 *  3. **運営を名乗れないこと。** 「この出品は運営がやっている」と誤解させない。
 *  4. **断る理由を分けて返すこと。** 「使われている」と「運営とまぎらわしい」は
 *     直し方が違う。同じ符号にすると、本人は別の名前を何度も試すことになる。
 */

let app: INestApplication;
let harness: TestHarness;

const PATH = '/api/v1/creator/profile';

function tokenFor(subject: string): string {
  const nowSeconds = Math.floor(TEST_NOW.getTime() / 1000);
  return createDevToken(TEST_TOKEN_SECRET, {
    sub: subject,
    iss: TEST_ISSUER,
    aud: TEST_AUDIENCE,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  });
}

function actorToken(role: Role, subject: string): string {
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

  it('未認証では書けない', async () => {
    await request(app.getHttpServer()).put(PATH).send({ displayName: '戦国工房' }).expect(401);
  });

  it('会員は自分の分を読み書きできる（出品する人はここから始まる）', async () => {
    /*
      ⚠️ **`creator` という役割は無い。** 出品するのは会員（`buyer`）で、
         作品の持ち主かどうかで判定している。ここを `operator` 限定に
         すると、出品者が自分の名前を決められなくなる。
    */
    const token = actorToken('buyer', 'creator-1');
    await request(app.getHttpServer()).put(PATH).set(auth(token)).send({ displayName: '戦国工房' });
    const read = await request(app.getHttpServer()).get(PATH).set(auth(token)).expect(200);
    expect(read.body).toEqual({ displayName: '戦国工房' });
  });

  it('監査担当は書き換えられない（見る役目であって、名乗る役目ではない）', async () => {
    await request(app.getHttpServer())
      .put(PATH)
      .set(auth(actorToken('auditor', 'auditor-1')))
      .send({ displayName: '監査の人' })
      .expect(403);
  });
});

describe('自分の分しか触れない', () => {
  it('本文でほかの人のアカウントを指しても、自分の名前が変わるだけ', async () => {
    /*
      ⚠️ **ここが要。** 「誰の分か」は**トークンからだけ**取る。本文の
         `accountId` を見に行く実装へ変わると、他人の名前を書き換えられる。
    */
    const victim = actorToken('buyer', 'victim-1');
    await request(app.getHttpServer())
      .put(PATH)
      .set(auth(victim))
      .send({ displayName: '被害者の工房' })
      .expect(200);

    const attacker = actorToken('buyer', 'attacker-1');
    await request(app.getHttpServer())
      .put(PATH)
      .set(auth(attacker))
      .send({ displayName: '乗っ取り工房', accountId: 'account-victim-1' })
      .expect(200);

    const victimRead = await request(app.getHttpServer()).get(PATH).set(auth(victim)).expect(200);
    expect(victimRead.body).toEqual({ displayName: '被害者の工房' });

    const attackerRead = await request(app.getHttpServer())
      .get(PATH)
      .set(auth(attacker))
      .expect(200);
    expect(attackerRead.body).toEqual({ displayName: '乗っ取り工房' });
  });

  it('運営にも他人の表示名を変える口が無い', async () => {
    /*
      ⚠️ **なりすましへの対応は、名前の書き換えではなくアカウントの停止で行う。**
         運営が名前を差し替えられる口を作ると、そこが乗っ取りの的になる。
    */
    const operator = actorToken('operator', 'operator-1');
    await request(app.getHttpServer())
      .put(PATH)
      .set(auth(operator))
      .send({ displayName: '差し替え後', accountId: 'someone-else' })
      .expect(200);

    // 運営自身の名前が変わっただけ。指した相手には何も起きていない。
    const read = await request(app.getHttpServer()).get(PATH).set(auth(operator)).expect(200);
    expect(read.body).toEqual({ displayName: '差し替え後' });
  });
});

describe('まだ決めていないとき', () => {
  it('未登録なら null を返す（代わりの文言を作らない）', async () => {
    const read = await request(app.getHttpServer())
      .get(PATH)
      .set(auth(actorToken('buyer', 'new-1')))
      .expect(200);
    expect(read.body).toEqual({ displayName: null });
  });
});

describe('重複を許さない', () => {
  it('同じ名前は 2 人目が断られる', async () => {
    await request(app.getHttpServer())
      .put(PATH)
      .set(auth(actorToken('buyer', 'first-1')))
      .send({ displayName: '陣羽織屋' })
      .expect(200);

    const second = await request(app.getHttpServer())
      .put(PATH)
      .set(auth(actorToken('buyer', 'second-1')))
      .send({ displayName: '陣羽織屋' })
      .expect(409);
    expect(second.body.error.code).toBe('DISPLAY_NAME_TAKEN');
  });

  it.each([
    ['全角と半角', 'Ａ工房', 'A工房'],
    ['大文字と小文字', 'Taro Studio', 'taro studio'],
    ['空白の有無', '戦国 太郎', '戦国太郎'],
  ])('%s の違いだけでは別の名前にならない', async (_label, first, second) => {
    /*
      ⚠️ **ここが抜けると、重複を禁じた意味が無くなる。** 買う人には
         どれも同じに見える。実質のなりすましになる。
    */
    await request(app.getHttpServer())
      .put(PATH)
      .set(auth(actorToken('buyer', `dup-a-${first}`)))
      .send({ displayName: first })
      .expect(200);

    const response = await request(app.getHttpServer())
      .put(PATH)
      .set(auth(actorToken('buyer', `dup-b-${first}`)))
      .send({ displayName: second })
      .expect(409);
    expect(response.body.error.code).toBe('DISPLAY_NAME_TAKEN');
  });

  it('自分の名前を同じ値で登録し直せる（自分自身とは衝突しない）', async () => {
    const token = actorToken('buyer', 'again-1');
    await request(app.getHttpServer())
      .put(PATH)
      .set(auth(token))
      .send({ displayName: 'あかつき絵巻' })
      .expect(200);
    await request(app.getHttpServer())
      .put(PATH)
      .set(auth(token))
      .send({ displayName: 'あかつき絵巻' })
      .expect(200);
  });

  it('別の名前なら通る（そろえすぎて別人を弾かない）', async () => {
    await request(app.getHttpServer())
      .put(PATH)
      .set(auth(actorToken('buyer', 'kana-1')))
      .send({ displayName: 'サクラ' })
      .expect(200);
    // ⚠️ カタカナとひらがなはまとめない。弾かれた側は自分では直せない。
    await request(app.getHttpServer())
      .put(PATH)
      .set(auth(actorToken('buyer', 'kana-2')))
      .send({ displayName: 'さくら' })
      .expect(200);
  });
});

describe('断る理由を分ける', () => {
  it('運営を名乗る名前は 400 と DISPLAY_NAME_RESERVED', async () => {
    const response = await request(app.getHttpServer())
      .put(PATH)
      .set(auth(actorToken('buyer', 'reserved-1')))
      .send({ displayName: '千ノ国NFTマーケット公式' })
      .expect(400);
    /*
      ⚠️ **「使われています」と混ぜない。** 混ぜると、本人は別の名前を
         いくつも試すことになる。直し方が違う。
    */
    expect(response.body.error.code).toBe('DISPLAY_NAME_RESERVED');
  });

  it('目に見えない文字を混ぜた名前を断る', async () => {
    // ⚠️ ゼロ幅文字。正規化しても消えないので、同じ見た目の名前を量産できる。
    const response = await request(app.getHttpServer())
      .put(PATH)
      .set(auth(actorToken('buyer', 'invisible-1')))
      .send({ displayName: '戦国​工房' })
      .expect(400);
    expect(response.body.error.code).toBe('DISPLAY_NAME_INVALID');
  });

  it('長すぎる名前を断る', async () => {
    await request(app.getHttpServer())
      .put(PATH)
      .set(auth(actorToken('buyer', 'long-1')))
      .send({ displayName: 'あ'.repeat(41) })
      .expect(400);
  });

  it('空の名前を断る', async () => {
    await request(app.getHttpServer())
      .put(PATH)
      .set(auth(actorToken('buyer', 'empty-1')))
      .send({ displayName: '   ' })
      .expect(400);
  });
});

describe('記録', () => {
  it('改名を監査ログへ残す（なりすましの相談を受けたときに追える）', async () => {
    const token = actorToken('buyer', 'audit-1');
    await request(app.getHttpServer())
      .put(PATH)
      .set(auth(token))
      .send({ displayName: '宵の口' })
      .expect(200);
    await request(app.getHttpServer())
      .put(PATH)
      .set(auth(token))
      .send({ displayName: '宵の口あらため' })
      .expect(200);

    const entries = harness.audit.entries.filter(
      (entry) => entry.action === 'profile.display_name_updated',
    );
    expect(entries).toHaveLength(2);
    // ⚠️ 代替実装はトークンの `sub` に `account-` を足したものをアカウントIDにする。
    expect(entries[0]?.actorAccountId).toBe('account-audit-1');
    // ⚠️ 操作した人と対象が同じ。自分の分しか触れないことがここにも出る。
    expect(entries[0]?.targetId).toBe('account-audit-1');
    // ⚠️ 名前そのものを残す。公開ページに出る値で、秘密ではない。
    expect(entries[1]?.summary).toEqual({ displayName: '宵の口あらため' });
  });

  it('断られた改名は記録に残らない（起きていないことを残さない）', async () => {
    await request(app.getHttpServer())
      .put(PATH)
      .set(auth(actorToken('buyer', 'noaudit-1')))
      .send({ displayName: '運営' })
      .expect(400);
    expect(harness.audit.actions()).not.toContain('profile.display_name_updated');
  });
});
