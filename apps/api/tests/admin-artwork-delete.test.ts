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
  sampleListing,
  TEST_AUDIENCE,
  TEST_ISSUER,
  TEST_NOW,
  TEST_TOKEN_SECRET,
  type TestHarness,
} from './helpers/doubles';

/**
 * 運営による作品の削除（`UD-113` 仮決定）。
 *
 * ⚠️ **この試験の主題は「消せないこと」。**
 * 消す操作は取り消せないので、条件が緩む方向のずれだけが事故になる。
 * 「消せた」より「消せなかった」を厚く確かめる。
 */

let app: INestApplication;
let harness: TestHarness;

function actorToken(role: Role, subject = `user-${role}`): string {
  harness.accounts.seed(subject, role);
  return createDevToken(TEST_TOKEN_SECRET, {
    sub: subject,
    iss: TEST_ISSUER,
    aud: TEST_AUDIENCE,
    exp: Math.floor(TEST_NOW.getTime() / 1000) + 3600,
  });
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

describe('DELETE /api/v1/admin/artworks/:id', () => {
  it('operator は、売れていない作品を出品ごと消せる', async () => {
    harness.artworks.seed(sampleArtwork({ id: 'a-1', status: 'archived' }));
    harness.listings.seed(sampleListing({ id: 'l-1', artworkId: 'a-1', status: 'ended' }));

    await request(app.getHttpServer())
      .delete('/api/v1/admin/artworks/a-1')
      .set('Authorization', `Bearer ${actorToken('operator')}`)
      .expect(204);

    expect(await harness.artworks.findById('a-1')).toBeNull();
    // ⚠️ 出品が残ると、消えた作品を指す行が居座る。
    expect(await harness.listings.findById('l-1')).toBeNull();
  });

  it('消したことを監査ログに残す', async () => {
    harness.artworks.seed(sampleArtwork({ id: 'a-1', status: 'draft' }));

    await request(app.getHttpServer())
      .delete('/api/v1/admin/artworks/a-1')
      .set('Authorization', `Bearer ${actorToken('operator')}`)
      .expect(204);

    const entry = harness.audit.entries.find((item) => item.action === 'artwork.delete');
    expect(entry).toBeDefined();
    expect(entry?.targetId).toBe('a-1');
    // ⚠️ 題名は残さない。出品者が入れた文字が長期に残る場所には置かない。
    expect(JSON.stringify(entry?.summary)).not.toContain('サンプル作品');
  });

  it('画像も消す（どこからも参照されないゴミを残さない）', async () => {
    harness.artworks.seed(
      sampleArtwork({ id: 'a-1', status: 'draft', imageKey: 'images/gone.png' }),
    );
    await harness.storage.put({
      key: 'images/gone.png',
      contentType: 'image/png',
      bytes: new Uint8Array([1, 2, 3]),
    });

    await request(app.getHttpServer())
      .delete('/api/v1/admin/artworks/a-1')
      .set('Authorization', `Bearer ${actorToken('operator')}`)
      .expect(204);

    expect(harness.storage.has('images/gone.png')).toBe(false);
  });

  it('公開中の作品は消せない（先に公開をやめさせる）', async () => {
    harness.artworks.seed(sampleArtwork({ id: 'a-1', status: 'published' }));

    await request(app.getHttpServer())
      .delete('/api/v1/admin/artworks/a-1')
      .set('Authorization', `Bearer ${actorToken('operator')}`)
      .expect(409);

    expect(await harness.artworks.findById('a-1')).not.toBeNull();
  });

  it('お支払い待ちがあると消せない', async () => {
    harness.artworks.seed(sampleArtwork({ id: 'a-1', status: 'archived', reservedCount: 1 }));

    await request(app.getHttpServer())
      .delete('/api/v1/admin/artworks/a-1')
      .set('Authorization', `Bearer ${actorToken('operator')}`)
      .expect(409);

    expect(await harness.artworks.findById('a-1')).not.toBeNull();
  });

  it('発行済みがあると消せない', async () => {
    harness.artworks.seed(sampleArtwork({ id: 'a-1', status: 'archived', issuedCount: 1 }));

    await request(app.getHttpServer())
      .delete('/api/v1/admin/artworks/a-1')
      .set('Authorization', `Bearer ${actorToken('operator')}`)
      .expect(409);

    expect(await harness.artworks.findById('a-1')).not.toBeNull();
  });

  it('画像を消す前に判定する（消せなかった作品の画像を巻き添えにしない）', async () => {
    harness.artworks.seed(
      sampleArtwork({ id: 'a-1', status: 'published', imageKey: 'images/keep.png' }),
    );
    await harness.storage.put({
      key: 'images/keep.png',
      contentType: 'image/png',
      bytes: new Uint8Array([1, 2, 3]),
    });

    await request(app.getHttpServer())
      .delete('/api/v1/admin/artworks/a-1')
      .set('Authorization', `Bearer ${actorToken('operator')}`)
      .expect(409);

    expect(harness.storage.has('images/keep.png')).toBe(true);
  });

  it('存在しない作品は 404', async () => {
    await request(app.getHttpServer())
      .delete('/api/v1/admin/artworks/00000000-0000-4000-8000-000000000999')
      .set('Authorization', `Bearer ${actorToken('operator')}`)
      .expect(404);
  });

  it('2 回続けて消しても、二重に何かが起きない（2 回目は 404）', async () => {
    harness.artworks.seed(sampleArtwork({ id: 'a-1', status: 'draft' }));
    const token = actorToken('operator');

    await request(app.getHttpServer())
      .delete('/api/v1/admin/artworks/a-1')
      .set('Authorization', `Bearer ${token}`)
      .expect(204);
    await request(app.getHttpServer())
      .delete('/api/v1/admin/artworks/a-1')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);

    expect(harness.audit.actions().filter((action) => action === 'artwork.delete')).toHaveLength(1);
  });
});

describe('作品の削除に手が届く範囲', () => {
  it('未認証では消せない', async () => {
    harness.artworks.seed(sampleArtwork({ id: 'a-1', status: 'draft' }));
    await request(app.getHttpServer()).delete('/api/v1/admin/artworks/a-1').expect(401);
    expect(await harness.artworks.findById('a-1')).not.toBeNull();
  });

  it('buyer（会員）は消せない', async () => {
    harness.artworks.seed(sampleArtwork({ id: 'a-1', status: 'draft' }));

    await request(app.getHttpServer())
      .delete('/api/v1/admin/artworks/a-1')
      .set('Authorization', `Bearer ${actorToken('buyer')}`)
      .expect(403);

    expect(await harness.artworks.findById('a-1')).not.toBeNull();
  });

  it('auditor（閲覧のみ）は消せない', async () => {
    harness.artworks.seed(sampleArtwork({ id: 'a-1', status: 'draft' }));

    await request(app.getHttpServer())
      .delete('/api/v1/admin/artworks/a-1')
      .set('Authorization', `Bearer ${actorToken('auditor')}`)
      .expect(403);

    expect(await harness.artworks.findById('a-1')).not.toBeNull();
  });

  it('出品者向けの経路には削除が無い（自分の作品でも消せない）', async () => {
    // ⚠️ 出品者が自分の作品を消せるようにするかは、まだ決めていない（`UD-113`）。
    //    決まっていないものを「持ち主だから」で通さない。
    harness.accounts.seed('ann', 'buyer');
    harness.artworks.seed(
      sampleArtwork({ id: 'a-1', status: 'draft', creatorAccountId: 'account-ann' }),
    );
    const token = createDevToken(TEST_TOKEN_SECRET, {
      sub: 'ann',
      iss: TEST_ISSUER,
      aud: TEST_AUDIENCE,
      exp: Math.floor(TEST_NOW.getTime() / 1000) + 3600,
    });

    await request(app.getHttpServer())
      .delete('/api/v1/creator/artworks/a-1')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);

    expect(await harness.artworks.findById('a-1')).not.toBeNull();
  });
});
