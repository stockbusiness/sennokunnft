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
  sampleArtwork,
  TEST_AUDIENCE,
  TEST_ISSUER,
  TEST_NOW,
  TEST_TOKEN_SECRET,
  type TestHarness,
} from './helpers/doubles';

/**
 * 出品者が自分の作品を扱う経路（`UD-102` 決定変更 2026-08-18）。
 *
 * ⚠️ **この試験の主題は「他人のものに手が届かないこと」。**
 * ロール判定だけで通す実装だと、他人の作品IDを指定して書き換えられる（IDOR）。
 * 作れること・出せることより、**届かないこと**を厚く確かめる。
 */

let app: INestApplication;
let harness: TestHarness;

/** 出品者の2人。`InMemoryAccountRepository` は `account-<subject>` を採番する。 */
const ANN = 'ann';
const BOB = 'bob';
const ANN_ID = `account-${ANN}`;
const BOB_ID = `account-${BOB}`;

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

const PNG = (() => {
  const bytes = Buffer.alloc(1024);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  return bytes;
})();

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

describe('出品者が自分の作品を登録する', () => {
  it('会員（buyer）は作品を登録でき、自分が持ち主になる', async () => {
    const token = actorToken('buyer', ANN);

    const response = await request(app.getHttpServer())
      .post('/api/v1/creator/artworks')
      .set('Authorization', `Bearer ${token}`)
      .send({ slug: 'ann-first', title: 'アンの作品', maxSupply: 5 })
      .expect(201);

    expect(response.body.creatorAccountId).toBe(ANN_ID);
    expect(response.body.status).toBe('draft');
  });

  it('持ち主を指定させない（他人名義で作れない）', async () => {
    const token = actorToken('buyer', ANN);

    const response = await request(app.getHttpServer())
      .post('/api/v1/creator/artworks')
      .set('Authorization', `Bearer ${token}`)
      // ⚠️ 送っても効かないこと。効くなら他人名義の作品を作れてしまう。
      .send({ slug: 'ann-second', title: '偽装', maxSupply: 1, creatorAccountId: BOB_ID })
      .expect(201);

    expect(response.body.creatorAccountId).toBe(ANN_ID);
  });

  it('認証なしでは登録できない', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/creator/artworks')
      .send({ slug: 'anon', title: '匿名', maxSupply: 1 })
      .expect(401);
  });

  it('登録から販売開始まで通しで行える', async () => {
    const token = actorToken('buyer', ANN);
    const auth = { Authorization: `Bearer ${token}` };

    const created = await request(app.getHttpServer())
      .post('/api/v1/creator/artworks')
      .set(auth)
      .send({ slug: 'ann-flow', title: '通しの作品', description: '説明', maxSupply: 3 })
      .expect(201);
    const id = created.body.id;

    await request(app.getHttpServer())
      .post(`/api/v1/creator/artworks/${id}/image`)
      .set(auth)
      .set('Content-Type', 'image/png')
      .send(PNG)
      .expect(200);

    const published = await request(app.getHttpServer())
      .post(`/api/v1/creator/artworks/${id}/publish`)
      .set(auth)
      .expect(200);
    expect(published.body.status).toBe('published');

    const listing = await request(app.getHttpServer())
      .post('/api/v1/creator/listings')
      .set(auth)
      .send({ artworkId: id, priceAmount: 3000, priceCurrency: 'JPY' })
      .expect(201);

    const activated = await request(app.getHttpServer())
      .post(`/api/v1/creator/listings/${listing.body.id}/activate`)
      .set(auth)
      .expect(200);
    expect(activated.body.status).toBe('active');

    // 公開カタログに出ること（出品者の操作だけで店先に並ぶ）。
    const catalog = await request(app.getHttpServer()).get('/api/v1/artworks').expect(200);
    expect(catalog.body.items.map((item: { slug: string }) => item.slug)).toContain('ann-flow');
  });
});

describe('他人のものには手が届かない（IDOR）', () => {
  /** ボブの作品と、その出品を用意する。 */
  async function bobsArtwork(): Promise<{ artworkId: string; listingId: string }> {
    const token = actorToken('buyer', BOB);
    const auth = { Authorization: `Bearer ${token}` };
    const created = await request(app.getHttpServer())
      .post('/api/v1/creator/artworks')
      .set(auth)
      .send({ slug: 'bobs-work', title: 'ボブの作品', maxSupply: 5 })
      .expect(201);
    const listing = await request(app.getHttpServer())
      .post('/api/v1/creator/listings')
      .set(auth)
      .send({ artworkId: created.body.id, priceAmount: 1000, priceCurrency: 'JPY' })
      .expect(201);
    return { artworkId: created.body.id, listingId: listing.body.id };
  }

  /**
   * ⚠️ **403 ではなく 404 を返す。**
   * 403 は「在るが触れない」と答えてしまい、IDを総当たりすれば
   * どのIDが実在するかを数えられる。下書きの存在まで漏れる。
   */
  it('他人の作品は見られない（404。403 にしない）', async () => {
    const { artworkId } = await bobsArtwork();
    const ann = actorToken('buyer', ANN);

    await request(app.getHttpServer())
      .get(`/api/v1/creator/artworks/${artworkId}`)
      .set('Authorization', `Bearer ${ann}`)
      .expect(404);
  });

  it('他人の作品は書き換えられない', async () => {
    const { artworkId } = await bobsArtwork();
    const ann = actorToken('buyer', ANN);

    await request(app.getHttpServer())
      .patch(`/api/v1/creator/artworks/${artworkId}`)
      .set('Authorization', `Bearer ${ann}`)
      .send({ title: '乗っ取り' })
      .expect(404);
  });

  it.each(['publish', 'archive'])('他人の作品を %s できない', async (action) => {
    const { artworkId } = await bobsArtwork();
    const ann = actorToken('buyer', ANN);

    await request(app.getHttpServer())
      .post(`/api/v1/creator/artworks/${artworkId}/${action}`)
      .set('Authorization', `Bearer ${ann}`)
      .expect(404);
  });

  it('他人の作品に画像を差し替えられない（保存もされない）', async () => {
    const { artworkId } = await bobsArtwork();
    const ann = actorToken('buyer', ANN);
    const before = harness.storage.size();

    await request(app.getHttpServer())
      .post(`/api/v1/creator/artworks/${artworkId}/image`)
      .set('Authorization', `Bearer ${ann}`)
      .set('Content-Type', 'image/png')
      .send(PNG)
      .expect(404);

    // ⚠️ 所有権を確かめる前に保存すると、拒否しても物だけ残る。
    expect(harness.storage.size()).toBe(before);
  });

  it('他人の作品に出品を作れない', async () => {
    const { artworkId } = await bobsArtwork();
    const ann = actorToken('buyer', ANN);

    await request(app.getHttpServer())
      .post('/api/v1/creator/listings')
      .set('Authorization', `Bearer ${ann}`)
      .send({ artworkId, priceAmount: 100, priceCurrency: 'JPY' })
      .expect(404);
  });

  it.each(['activate', 'suspend', 'end'])('他人の出品を %s できない', async (action) => {
    const { listingId } = await bobsArtwork();
    const ann = actorToken('buyer', ANN);

    await request(app.getHttpServer())
      .post(`/api/v1/creator/listings/${listingId}/${action}`)
      .set('Authorization', `Bearer ${ann}`)
      .expect(404);
  });

  it('一覧には自分の作品しか出ない', async () => {
    await bobsArtwork();
    const ann = actorToken('buyer', ANN);
    await request(app.getHttpServer())
      .post('/api/v1/creator/artworks')
      .set('Authorization', `Bearer ${ann}`)
      .send({ slug: 'anns-work', title: 'アンの作品', maxSupply: 1 })
      .expect(201);

    const response = await request(app.getHttpServer())
      .get('/api/v1/creator/artworks')
      .set('Authorization', `Bearer ${ann}`)
      .expect(200);

    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].slug).toBe('anns-work');
  });
});

describe('運営との関係', () => {
  it('管理APIは会員に開かない（一括保護が弱まっていないこと）', async () => {
    // ⚠️ ここが 200 になったら、admin を「所有者なら通す」に
    //    変えてしまっている。入口を分けた意味が消える。
    const ann = actorToken('buyer', ANN);
    await request(app.getHttpServer())
      .get('/api/v1/admin/artworks')
      .set('Authorization', `Bearer ${ann}`)
      .expect(403);
  });

  it('運営は他人の作品も止められる（審査は無いが、下ろす経路はある）', async () => {
    harness.artworks.seed(sampleArtwork({ id: 'a-bob', creatorAccountId: BOB_ID }));
    const operator = actorToken('operator');

    await request(app.getHttpServer())
      .post('/api/v1/creator/artworks/a-bob/archive')
      .set('Authorization', `Bearer ${operator}`)
      .expect(200);
  });

  it('監査（auditor）は読み取り専用なので出品できない', async () => {
    const auditor = actorToken('auditor');
    await request(app.getHttpServer())
      .post('/api/v1/creator/artworks')
      .set('Authorization', `Bearer ${auditor}`)
      .send({ slug: 'auditor-work', title: '監査の作品', maxSupply: 1 })
      .expect(403);
  });
});
