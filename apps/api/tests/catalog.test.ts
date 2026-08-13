import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { artworkDetailSchema, artworkListResponseSchema } from '@sengoku/contracts';
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

/** 指定ロールのアカウントを用意し、その利用者のトークンを返す。 */
function actorToken(role: Role, subject = `user-${role}`): string {
  harness.accounts.seed(subject, role);
  return tokenFor(subject);
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

describe('公開カタログ GET /api/v1/artworks', () => {
  it('認証なしで一覧を取得できる', async () => {
    harness.artworks.seed(sampleArtwork());
    harness.listings.seed(sampleListing());

    const response = await request(app.getHttpServer()).get('/api/v1/artworks').expect(200);

    expect(artworkListResponseSchema.safeParse(response.body).success).toBe(true);
    expect(response.body.items).toHaveLength(1);
  });

  it('未公開の作品を一覧に含めない', async () => {
    harness.artworks.seed(sampleArtwork({ id: 'a-1', slug: 'published', status: 'published' }));
    harness.artworks.seed(sampleArtwork({ id: 'a-2', slug: 'draft', status: 'draft' }));
    harness.artworks.seed(sampleArtwork({ id: 'a-3', slug: 'archived', status: 'archived' }));

    const response = await request(app.getHttpServer()).get('/api/v1/artworks').expect(200);

    expect(response.body.items.map((item: { slug: string }) => item.slug)).toEqual(['published']);
  });

  it('販売中の出品があれば価格を返す', async () => {
    harness.artworks.seed(sampleArtwork());
    harness.listings.seed(sampleListing({ price: { amountMinor: 9800, currency: 'JPY' } }));

    const response = await request(app.getHttpServer()).get('/api/v1/artworks').expect(200);

    expect(response.body.items[0].price).toEqual({ amount: 9800, currency: 'JPY' });
    expect(response.body.items[0].purchasable).toBe(true);
  });

  it('出品がなければ価格は null で購入不可', async () => {
    harness.artworks.seed(sampleArtwork());

    const response = await request(app.getHttpServer()).get('/api/v1/artworks').expect(200);

    expect(response.body.items[0].price).toBeNull();
    expect(response.body.items[0].purchasable).toBe(false);
  });

  it('残数は仮引当を差し引いて返す', async () => {
    // 決済待ちが押さえている分は「買える数」ではない。
    harness.artworks.seed(sampleArtwork({ maxSupply: 10, reservedCount: 3, issuedCount: 2 }));

    const response = await request(app.getHttpServer()).get('/api/v1/artworks').expect(200);

    expect(response.body.items[0].availableSupply).toBe(5);
  });

  it('limit の上限を超える指定を拒否する', async () => {
    await request(app.getHttpServer()).get('/api/v1/artworks?limit=1000').expect(400);
  });

  it('ページングのカーソルを返す', async () => {
    for (let i = 0; i < 3; i += 1) {
      harness.artworks.seed(sampleArtwork({ id: `a-${String(i)}`, slug: `artwork-${String(i)}` }));
    }

    const first = await request(app.getHttpServer()).get('/api/v1/artworks?limit=2').expect(200);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).not.toBeNull();

    const second = await request(app.getHttpServer())
      .get(`/api/v1/artworks?limit=2&cursor=${String(first.body.nextCursor)}`)
      .expect(200);
    expect(second.body.items).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();
  });
});

describe('公開カタログ GET /api/v1/artworks/:slug', () => {
  it('公開作品の詳細を返す', async () => {
    harness.artworks.seed(sampleArtwork());
    harness.listings.seed(sampleListing());

    const response = await request(app.getHttpServer())
      .get('/api/v1/artworks/sample-artwork')
      .expect(200);

    expect(artworkDetailSchema.safeParse(response.body).success).toBe(true);
    expect(response.body.unavailableReason).toBeNull();
  });

  it('存在しない作品は 404', async () => {
    await request(app.getHttpServer()).get('/api/v1/artworks/missing').expect(404);
  });

  it('未公開の作品も 404（存在を漏らさない）', async () => {
    // 403 にすると「その slug の作品は存在する」と教えることになる。
    harness.artworks.seed(sampleArtwork({ slug: 'secret', status: 'draft' }));
    await request(app.getHttpServer()).get('/api/v1/artworks/secret').expect(404);
  });

  it('売り切れの理由を返す', async () => {
    harness.artworks.seed(sampleArtwork({ maxSupply: 1, issuedCount: 1 }));
    harness.listings.seed(sampleListing());

    const response = await request(app.getHttpServer())
      .get('/api/v1/artworks/sample-artwork')
      .expect(200);

    expect(response.body.purchasable).toBe(false);
    expect(response.body.unavailableReason).toBe('sold_out');
  });

  it('販売開始前の理由を返す', async () => {
    harness.artworks.seed(sampleArtwork());
    harness.listings.seed(sampleListing({ startsAt: new Date(TEST_NOW.getTime() + 86_400_000) }));

    const response = await request(app.getHttpServer())
      .get('/api/v1/artworks/sample-artwork')
      .expect(200);

    expect(response.body.unavailableReason).toBe('not_started');
  });
});

describe('管理API の認可（AUTHORIZATION_DESIGN §2.3）', () => {
  it('未認証では管理APIを呼べない', async () => {
    await request(app.getHttpServer()).get('/api/v1/admin/artworks').expect(401);
  });

  it('buyer では管理APIを呼べない（Z-5）', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/artworks')
      .set('Authorization', `Bearer ${actorToken('buyer')}`)
      .expect(403);
  });

  it('auditor は閲覧できるが作成はできない', async () => {
    const token = actorToken('auditor');
    await request(app.getHttpServer())
      .get('/api/v1/admin/artworks')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/admin/artworks')
      .set('Authorization', `Bearer ${token}`)
      .send({ slug: 'new-artwork', title: '新作', maxSupply: 5 })
      .expect(403);
  });

  it('operator は作成できる', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/admin/artworks')
      .set('Authorization', `Bearer ${actorToken('operator')}`)
      .send({ slug: 'new-artwork', title: '新作', maxSupply: 5 })
      .expect(201);
  });

  it('不正なトークンでは呼べない', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/artworks')
      .set('Authorization', 'Bearer not-a-token')
      .expect(401);
  });

  it('停止中のアカウントでは呼べない', async () => {
    harness.accounts.seed('suspended-op', 'operator', 'suspended');
    await request(app.getHttpServer())
      .get('/api/v1/admin/artworks')
      .set('Authorization', `Bearer ${tokenFor('suspended-op')}`)
      .expect(403);
  });

  it('初回アクセスのアカウントは buyer として作られる（昇格経路を作らない）', async () => {
    // アカウントを事前に用意せずにアクセスする。
    await request(app.getHttpServer())
      .get('/api/v1/admin/artworks')
      .set('Authorization', `Bearer ${tokenFor('brand-new-user')}`)
      .expect(403);
  });
});

describe('管理API 作品の操作', () => {
  function asOperator(): string {
    return actorToken('operator');
  }

  it('作品を登録すると下書きになる', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/admin/artworks')
      .set('Authorization', `Bearer ${asOperator()}`)
      .send({ slug: 'new-artwork', title: '新作', maxSupply: 5, imageKey: 'images/x.png' })
      .expect(201);

    expect(response.body.status).toBe('draft');
    expect(response.body.availableSupply).toBe(5);
  });

  it('slug の形式が不正なら 400', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/admin/artworks')
      .set('Authorization', `Bearer ${asOperator()}`)
      .send({ slug: 'Invalid Slug', title: '新作', maxSupply: 5 })
      .expect(400);
  });

  it('画像がない作品は公開できない', async () => {
    harness.artworks.seed(sampleArtwork({ id: 'a-1', status: 'draft', imageKey: null }));
    await request(app.getHttpServer())
      .post('/api/v1/admin/artworks/a-1/publish')
      .set('Authorization', `Bearer ${asOperator()}`)
      .expect(404);
  });

  it('公開後は発行上限を変更できない（409）', async () => {
    harness.artworks.seed(sampleArtwork({ id: 'a-1', status: 'published' }));

    const response = await request(app.getHttpServer())
      .patch('/api/v1/admin/artworks/a-1')
      .set('Authorization', `Bearer ${asOperator()}`)
      .send({ maxSupply: 999 })
      .expect(409);

    expect(response.body.error.code).toBe('ARTWORK_SUPPLY_IMMUTABLE');
  });

  it('公開後でもタイトルは変更できる', async () => {
    harness.artworks.seed(sampleArtwork({ id: 'a-1', status: 'published' }));
    const response = await request(app.getHttpServer())
      .patch('/api/v1/admin/artworks/a-1')
      .set('Authorization', `Bearer ${asOperator()}`)
      .send({ title: '改題' })
      .expect(200);
    expect(response.body.title).toBe('改題');
  });

  it('存在しない作品の操作は 404', async () => {
    await request(app.getHttpServer())
      .patch('/api/v1/admin/artworks/00000000-0000-4000-8000-000000000999')
      .set('Authorization', `Bearer ${asOperator()}`)
      .send({ title: 'x' })
      .expect(404);
  });
});

describe('管理API 出品の操作', () => {
  function asOperator(): string {
    return actorToken('operator');
  }

  it('未公開の作品の出品は販売開始できない（409）', async () => {
    harness.artworks.seed(sampleArtwork({ id: 'a-1', status: 'draft' }));
    harness.listings.seed(sampleListing({ id: 'l-1', artworkId: 'a-1', status: 'draft' }));

    const response = await request(app.getHttpServer())
      .post('/api/v1/admin/listings/l-1/activate')
      .set('Authorization', `Bearer ${asOperator()}`)
      .expect(409);

    expect(response.body.error.code).toBe('ARTWORK_NOT_PUBLISHED');
  });

  it('公開済みの作品なら販売開始できる', async () => {
    harness.artworks.seed(sampleArtwork({ id: 'a-1', status: 'published' }));
    harness.listings.seed(sampleListing({ id: 'l-1', artworkId: 'a-1', status: 'draft' }));

    const response = await request(app.getHttpServer())
      .post('/api/v1/admin/listings/l-1/activate')
      .set('Authorization', `Bearer ${asOperator()}`)
      .expect(201);

    expect(response.body.status).toBe('active');
  });

  it('販売中の出品は編集できない（409）', async () => {
    harness.artworks.seed(sampleArtwork({ id: 'a-1' }));
    harness.listings.seed(sampleListing({ id: 'l-1', artworkId: 'a-1', status: 'active' }));

    const response = await request(app.getHttpServer())
      .patch('/api/v1/admin/listings/l-1')
      .set('Authorization', `Bearer ${asOperator()}`)
      .send({ priceAmount: 100 })
      .expect(409);

    expect(response.body.error.code).toBe('LISTING_NOT_EDITABLE');
  });

  it('小数の価格を拒否する（400）', async () => {
    harness.artworks.seed(sampleArtwork({ id: 'a-1' }));
    await request(app.getHttpServer())
      .post('/api/v1/admin/listings')
      .set('Authorization', `Bearer ${asOperator()}`)
      .send({ artworkId: 'a-1', priceAmount: 120.5, priceCurrency: 'JPY' })
      .expect(400);
  });

  it('存在しない作品への出品は 404', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/admin/listings')
      .set('Authorization', `Bearer ${asOperator()}`)
      .send({
        artworkId: '00000000-0000-4000-8000-000000000999',
        priceAmount: 1000,
        priceCurrency: 'JPY',
      })
      .expect(404);
  });

  it('エラー応答にスタックトレースを含めない（L-5）', async () => {
    harness.artworks.seed(sampleArtwork({ id: 'a-1', status: 'published' }));

    const response = await request(app.getHttpServer())
      .patch('/api/v1/admin/artworks/a-1')
      .set('Authorization', `Bearer ${asOperator()}`)
      .send({ maxSupply: 999 })
      .expect(409);

    const body = JSON.stringify(response.body);
    expect(body).not.toContain('at ');
    expect(body).not.toContain('.ts:');
    expect(response.body.error.code).toBeTruthy();
  });
});
