import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  artworkDetailSchema,
  artworkListResponseSchema,
  publicListingListResponseSchema,
} from '@sengoku/contracts';
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

  it('画像URLをサーバー側で解決して返す', async () => {
    // ⚠️ キーだけを返すと、画面側が公開ドメインを持つことになる。
    //    設定が 2 か所になり、ずれても落ちず、画像が出なくなるまで気づけない。
    harness.artworks.seed(sampleArtwork({ imageKey: 'artworks/2026/08/abc.png' }));

    const response = await request(app.getHttpServer()).get('/api/v1/artworks').expect(200);

    expect(response.body.items[0].imageKey).toBe('artworks/2026/08/abc.png');
    expect(response.body.items[0].imageUrl).toBe(
      harness.storage.publicUrl('artworks/2026/08/abc.png'),
    );
  });

  it('画像が無ければ画像URLも null にする', async () => {
    // 公開には画像が要る（`publishArtwork` が拒否する）ので通常は起きないが、
    // 保存先の障害や過去データの取りこぼしで欠けたときに画面を崩さない。
    harness.artworks.seed(sampleArtwork({ imageKey: null }));

    const response = await request(app.getHttpServer()).get('/api/v1/artworks').expect(200);

    expect(response.body.items[0].imageUrl).toBeNull();
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
      .expect(200);

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

describe('公開出品API GET /api/v1/listings', () => {
  it('認証なしで販売中の出品を取得できる', async () => {
    harness.artworks.seed(sampleArtwork());
    harness.listings.seed(sampleListing());

    const response = await request(app.getHttpServer()).get('/api/v1/listings').expect(200);

    expect(publicListingListResponseSchema.safeParse(response.body).success).toBe(true);
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].displayState).toBe('on_sale');
  });

  it('未公開作品の出品は返さない', async () => {
    harness.artworks.seed(sampleArtwork({ id: 'a-1', status: 'draft' }));
    harness.listings.seed(sampleListing({ id: 'l-1', artworkId: 'a-1', status: 'active' }));

    const response = await request(app.getHttpServer()).get('/api/v1/listings').expect(200);
    expect(response.body.items).toHaveLength(0);
  });

  it('下書きの出品は返さない', async () => {
    harness.artworks.seed(sampleArtwork());
    harness.listings.seed(sampleListing({ status: 'draft' }));

    const response = await request(app.getHttpServer()).get('/api/v1/listings').expect(200);
    expect(response.body.items).toHaveLength(0);
  });

  it('販売予定は scheduled として返す', async () => {
    harness.artworks.seed(sampleArtwork());
    harness.listings.seed(
      sampleListing({ status: 'scheduled', startsAt: new Date(TEST_NOW.getTime() + 86_400_000) }),
    );

    const response = await request(app.getHttpServer()).get('/api/v1/listings').expect(200);
    expect(response.body.items[0].displayState).toBe('scheduled');
  });
});

describe('公開出品API GET /api/v1/listings/:id', () => {
  it('販売中の出品を取得できる', async () => {
    harness.artworks.seed(sampleArtwork());
    harness.listings.seed(sampleListing({ id: 'l-1' }));

    const response = await request(app.getHttpServer()).get('/api/v1/listings/l-1').expect(200);
    expect(response.body.artworkSlug).toBe('sample-artwork');
  });

  it('存在しない出品は 404', async () => {
    await request(app.getHttpServer()).get('/api/v1/listings/missing').expect(404);
  });

  it('未公開作品の出品も 404（存在を漏らさない）', async () => {
    harness.artworks.seed(sampleArtwork({ id: 'a-1', status: 'draft' }));
    harness.listings.seed(sampleListing({ id: 'l-1', artworkId: 'a-1', status: 'active' }));
    await request(app.getHttpServer()).get('/api/v1/listings/l-1').expect(404);
  });

  it('終了した出品も 404', async () => {
    harness.artworks.seed(sampleArtwork({ id: 'a-1' }));
    harness.listings.seed(sampleListing({ id: 'l-1', artworkId: 'a-1', status: 'ended' }));
    await request(app.getHttpServer()).get('/api/v1/listings/l-1').expect(404);
  });
});

describe('管理API 出品一覧 GET /api/v1/admin/listings', () => {
  it('operator は全状態の出品を見られる', async () => {
    harness.artworks.seed(sampleArtwork({ id: 'a-1' }));
    harness.listings.seed(sampleListing({ id: 'l-1', artworkId: 'a-1', status: 'draft' }));
    harness.listings.seed(sampleListing({ id: 'l-2', artworkId: 'a-1', status: 'ended' }));

    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/listings')
      .set('Authorization', `Bearer ${actorToken('operator')}`)
      .expect(200);

    expect(response.body.items).toHaveLength(2);
  });

  it('buyer は出品一覧を見られない', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/listings')
      .set('Authorization', `Bearer ${actorToken('buyer')}`)
      .expect(403);
  });

  it('作品で絞り込める', async () => {
    harness.artworks.seed(sampleArtwork({ id: '00000000-0000-4000-8000-00000000000a' }));
    harness.artworks.seed(sampleArtwork({ id: '00000000-0000-4000-8000-00000000000b', slug: 'b' }));
    harness.listings.seed(
      sampleListing({ id: 'l-1', artworkId: '00000000-0000-4000-8000-00000000000a' }),
    );
    harness.listings.seed(
      sampleListing({ id: 'l-2', artworkId: '00000000-0000-4000-8000-00000000000b' }),
    );

    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/listings?artworkId=00000000-0000-4000-8000-00000000000a')
      .set('Authorization', `Bearer ${actorToken('operator')}`)
      .expect(200);

    expect(response.body.items).toHaveLength(1);
  });
});

describe('画像アップロード POST /api/v1/admin/artworks/:id/image', () => {
  const PNG = (() => {
    const bytes = Buffer.alloc(1024);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
    return bytes;
  })();

  function upload(id: string, body: Buffer, contentType: string) {
    return request(app.getHttpServer())
      .post(`/api/v1/admin/artworks/${id}/image`)
      .set('Authorization', `Bearer ${actorToken('operator')}`)
      .set('Content-Type', contentType)
      .send(body);
  }

  it('PNG を受け付け、ランダムなキーで保存する', async () => {
    harness.artworks.seed(
      sampleArtwork({ id: 'a-1', imageKey: null, imageContentType: null, imageByteSize: null }),
    );

    const response = await upload('a-1', PNG, 'image/png').expect(200);

    expect(response.body.contentType).toBe('image/png');
    // 利用者が送ったファイル名は使わない。
    expect(response.body.imageKey).toMatch(/^artworks\//);
    expect(harness.storage.has(response.body.imageKey)).toBe(true);
  });

  it('SVG を拒否する（415）', async () => {
    harness.artworks.seed(sampleArtwork({ id: 'a-1' }));
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'.padEnd(200, ' '));
    const response = await upload('a-1', svg, 'image/svg+xml').expect(415);
    expect(response.body.error.code).toBe('IMAGE_UNSUPPORTED_TYPE');
  });

  it('拡張子を偽装したファイルを拒否する', async () => {
    // Content-Type は image/png だが中身は HTML。
    harness.artworks.seed(sampleArtwork({ id: 'a-1' }));
    const html = Buffer.from('<html></html>'.padEnd(200, ' '));
    await upload('a-1', html, 'image/png').expect(415);
  });

  it('サイズ超過を拒否する（413）', async () => {
    harness.artworks.seed(sampleArtwork({ id: 'a-1' }));
    const huge = Buffer.alloc(6 * 1024 * 1024);
    Buffer.from([0xff, 0xd8, 0xff]).copy(huge);
    const response = await upload('a-1', huge, 'image/jpeg').expect(413);
    expect(response.body.error.code).toBe('IMAGE_TOO_LARGE');
  });

  it('buyer はアップロードできない', async () => {
    harness.artworks.seed(sampleArtwork({ id: 'a-1' }));
    await request(app.getHttpServer())
      .post('/api/v1/admin/artworks/a-1/image')
      .set('Authorization', `Bearer ${actorToken('buyer')}`)
      .set('Content-Type', 'image/png')
      .send(PNG)
      .expect(403);
  });

  it('存在しない作品への登録は 404', async () => {
    await upload('missing', PNG, 'image/png').expect(404);
  });

  it('置換すると監査記録が残り、旧オブジェクトが消える', async () => {
    harness.artworks.seed(
      sampleArtwork({ id: 'a-1', imageKey: null, imageContentType: null, imageByteSize: null }),
    );

    const first = await upload('a-1', PNG, 'image/png').expect(200);
    const second = await upload('a-1', PNG, 'image/png').expect(200);

    expect(second.body.imageKey).not.toBe(first.body.imageKey);
    expect(harness.storage.has(first.body.imageKey)).toBe(false);
    expect(harness.audit.actions()).toContain('artwork.image.attach');
    expect(harness.audit.actions()).toContain('artwork.image.replace');
  });

  it('監査記録にファイルの中身を残さない', async () => {
    harness.artworks.seed(
      sampleArtwork({ id: 'a-1', imageKey: null, imageContentType: null, imageByteSize: null }),
    );
    await upload('a-1', PNG, 'image/png').expect(200);
    const raw = JSON.stringify(harness.audit.entries);
    expect(raw).not.toContain('PNG');
    expect(raw.length).toBeLessThan(2000);
  });
});

describe('HTML の保存を拒否する（XSS 対策）', () => {
  it('タイトルにタグを含む登録を拒否する', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/admin/artworks')
      .set('Authorization', `Bearer ${actorToken('operator')}`)
      .send({ slug: 'x-art', title: '<script>alert(1)</script>', maxSupply: 5 })
      .expect(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('説明文にタグを含む登録を拒否する', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/admin/artworks')
      .set('Authorization', `Bearer ${actorToken('operator')}`)
      .send({
        slug: 'x-art',
        title: '作品',
        description: '<img src=x onerror=alert(1)>',
        maxSupply: 5,
      })
      .expect(400);
  });

  it('HTML エンティティを含む説明文を拒否する', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/admin/artworks')
      .set('Authorization', `Bearer ${actorToken('operator')}`)
      .send({ slug: 'x-art', title: '作品', description: '&lt;script&gt;', maxSupply: 5 })
      .expect(400);
  });

  it('javascript: URL を含む説明文を拒否する', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/admin/artworks')
      .set('Authorization', `Bearer ${actorToken('operator')}`)
      .send({ slug: 'x-art', title: '作品', description: 'javascript:alert(1)', maxSupply: 5 })
      .expect(400);
  });

  it('通常の日本語の説明文は受け付ける', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/admin/artworks')
      .set('Authorization', `Bearer ${actorToken('operator')}`)
      .send({
        slug: 'ok-art',
        title: '戦国絵巻',
        description: '千ノ国の物語を描いた作品です。\n改行も使えます。',
        maxSupply: 5,
      })
      .expect(201);
  });
});

describe('冪等キー（API_DESIGN §3）', () => {
  it('同じキー・同じ内容の再送は 1 件しか作らない', async () => {
    const token = actorToken('operator');
    const key = '01J8Z7Q4XXXXXXXXXXXXXXXXXX';
    const body = { slug: 'idem-art', title: '作品', maxSupply: 5 };

    const first = await request(app.getHttpServer())
      .post('/api/v1/admin/artworks')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);

    const second = await request(app.getHttpServer())
      .post('/api/v1/admin/artworks')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);

    expect(second.body.id).toBe(first.body.id);

    const list = await request(app.getHttpServer())
      .get('/api/v1/admin/artworks')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(list.body.items).toHaveLength(1);
  });

  it('同じキーで内容が違えば 409', async () => {
    const token = actorToken('operator');
    const key = '01J8Z7Q4XXXXXXXXXXXXXXXXXX';

    await request(app.getHttpServer())
      .post('/api/v1/admin/artworks')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send({ slug: 'first-art', title: '作品', maxSupply: 5 })
      .expect(201);

    const conflict = await request(app.getHttpServer())
      .post('/api/v1/admin/artworks')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send({ slug: 'second-art', title: '別作品', maxSupply: 9 })
      .expect(409);

    expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('短すぎる冪等キーを拒否する', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/admin/artworks')
      .set('Authorization', `Bearer ${actorToken('operator')}`)
      .set('Idempotency-Key', 'abc')
      .send({ slug: 'x-art', title: '作品', maxSupply: 5 })
      .expect(400);
  });

  it('他人のキーを当てても他人の結果は返らない', async () => {
    // キーはアクターごとに区切る。区切らないと他人の応答を読み出せる。
    const key = '01J8Z7Q4XXXXXXXXXXXXXXXXXX';
    const operatorToken = actorToken('operator', 'op-a');
    harness.accounts.seed('op-b', 'operator');

    await request(app.getHttpServer())
      .post('/api/v1/admin/artworks')
      .set('Authorization', `Bearer ${operatorToken}`)
      .set('Idempotency-Key', key)
      .send({ slug: 'owned-art', title: '作品', maxSupply: 5 })
      .expect(201);

    // 別アクターが同じキーで別内容を送る → 前回の結果は返らず、新規作成になる。
    const other = await request(app.getHttpServer())
      .post('/api/v1/admin/artworks')
      .set('Authorization', `Bearer ${tokenFor('op-b')}`)
      .set('Idempotency-Key', key)
      .send({ slug: 'other-art', title: '別作品', maxSupply: 7 })
      .expect(201);

    expect(other.body.slug).toBe('other-art');
  });
});

describe('管理API 作品の非公開化（販売中の出品を残さない）', () => {
  it('非公開にすると、有効な出品も終了する', async () => {
    // 「非公開なのに販売中の出品がある」状態を運用手順で埋めない。
    harness.artworks.seed(sampleArtwork({ id: 'a-arch', status: 'published' }));
    harness.listings.seed(sampleListing({ id: 'l-active', artworkId: 'a-arch', status: 'active' }));

    await request(app.getHttpServer())
      .post('/api/v1/admin/artworks/a-arch/archive')
      .set('Authorization', `Bearer ${actorToken('operator')}`)
      .expect(200);

    const listing = await harness.listings.findById('l-active');
    expect(listing?.status).toBe('ended');
  });

  it('下書きの出品は書き換えない', async () => {
    harness.artworks.seed(sampleArtwork({ id: 'a-arch2', status: 'published' }));
    harness.listings.seed(sampleListing({ id: 'l-draft', artworkId: 'a-arch2', status: 'draft' }));

    await request(app.getHttpServer())
      .post('/api/v1/admin/artworks/a-arch2/archive')
      .set('Authorization', `Bearer ${actorToken('operator')}`)
      .expect(200);

    const listing = await harness.listings.findById('l-draft');
    expect(listing?.status).toBe('draft');
  });

  it('巻き込みで終了した出品を監査ログに残す', async () => {
    // 「知らないうちに販売が止まっていた」を後から追えるようにする。
    harness.artworks.seed(sampleArtwork({ id: 'a-arch3', status: 'published' }));
    harness.listings.seed(sampleListing({ id: 'l-a3', artworkId: 'a-arch3', status: 'active' }));

    await request(app.getHttpServer())
      .post('/api/v1/admin/artworks/a-arch3/archive')
      .set('Authorization', `Bearer ${actorToken('operator')}`)
      .expect(200);

    const entry = harness.audit.entries.find((item) => item.action === 'artwork.archive');
    expect(entry?.summary).toMatchObject({ endedListingIds: ['l-a3'] });
  });
});

describe('冪等キーと失敗（失敗したキーを塞いだままにしない）', () => {
  it('失敗した操作の冪等キーは、原因を直せば再利用できる', async () => {
    // 一度失敗しただけのキーが期限切れまで塞がると、
    // 利用者は同じ操作をやり直せなくなる。
    harness.artworks.seed(sampleArtwork({ id: 'a-retry', status: 'draft' }));
    harness.listings.seed(sampleListing({ id: 'l-retry', artworkId: 'a-retry', status: 'draft' }));
    const token = actorToken('operator');
    const key = '01J8Z7Q4RETRYXXXXXXXXXXXXX';

    // 未公開なので失敗する。
    await request(app.getHttpServer())
      .post('/api/v1/admin/listings/l-retry/activate')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .expect(409);

    // 原因を直す。
    await request(app.getHttpServer())
      .post('/api/v1/admin/artworks/a-retry/publish')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    // 同じキーでやり直せる（前回の失敗が再生されない）。
    const retry = await request(app.getHttpServer())
      .post('/api/v1/admin/listings/l-retry/activate')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .expect(200);

    expect(retry.body.status).toBe('active');
  });
});
