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
 * 買った方のマイページ（P0-3）。
 *
 * ⚠️ この組の主題は 3 つ。
 *   1. **ご自分の分しか見えないこと。** 誰の分かはトークンからだけ取る。
 *   2. **内部の言葉を返さないこと。** `issued` ではなく公開状態を返す。
 *   3. **買った方に関係の無い値を返さないこと。** 手数料・クリエイター配分は載せない。
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

describe('お受け取りの一覧 GET /api/v1/collectibles', () => {
  it('未認証では読めない', async () => {
    await request(app.getHttpServer()).get('/api/v1/collectibles').expect(401);
  });

  it('ご自分の分だけが返る', async () => {
    /*
      ⚠️ **ここが要。** 誰の分かはトークンからだけ取る。問い合わせ文字列で
         渡せる形にすると、そこが他人の持ち物を覗く道になる。
    */
    const mine = actorToken('buyer', 'buyer-1');
    harness.collectibles.seed({ accountId: 'account-buyer-1', artworkTitle: '私の作品' });
    harness.collectibles.seed({ accountId: 'account-buyer-2', artworkTitle: '他人の作品' });

    const response = await request(app.getHttpServer())
      .get('/api/v1/collectibles')
      .set(auth(mine))
      .expect(200);

    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].artworkTitle).toBe('私の作品');
  });

  it('本文で他人を指しても、自分の分しか返らない', async () => {
    const attacker = actorToken('buyer', 'attacker-1');
    harness.collectibles.seed({ accountId: 'account-victim-1' });

    const response = await request(app.getHttpServer())
      .get('/api/v1/collectibles')
      .query({ accountId: 'account-victim-1' })
      .set(auth(attacker))
      .expect(200);

    expect(response.body.items).toEqual([]);
  });

  it('内部の状態ではなく公開状態を返す', async () => {
    /*
      ⚠️ `issued` / `claimed` は運営の言葉で、買った方には「いま何が
         起きているか」が伝わらない。
    */
    const token = actorToken('buyer', 'buyer-1');
    harness.collectibles.seed({ accountId: 'account-buyer-1', status: 'issued' });

    const response = await request(app.getHttpServer())
      .get('/api/v1/collectibles')
      .set(auth(token))
      .expect(200);

    expect(response.body.items[0].status).toBe('PENDING');
  });

  it('受け取り済みは DELIVERED になる', async () => {
    const token = actorToken('buyer', 'buyer-1');
    harness.collectibles.seed({
      accountId: 'account-buyer-1',
      status: 'claimed',
      deliveryStatus: 'delivered',
    });

    const response = await request(app.getHttpServer())
      .get('/api/v1/collectibles')
      .set(auth(token))
      .expect(200);

    expect(response.body.items[0].status).toBe('DELIVERED');
  });

  it('画像は URL で返す（キーを画面へ渡さない）', async () => {
    // ⚠️ キーを返して画面側で組み立てると、公開ドメインの設定が 2 か所になる。
    const token = actorToken('buyer', 'buyer-1');
    harness.collectibles.seed({ accountId: 'account-buyer-1' });

    const response = await request(app.getHttpServer())
      .get('/api/v1/collectibles')
      .set(auth(token))
      .expect(200);

    expect(response.body.items[0]).toHaveProperty('imageUrl');
    expect(response.body.items[0]).not.toHaveProperty('imageKey');
  });

  it('金額も手数料も返さない', async () => {
    const token = actorToken('buyer', 'buyer-1');
    harness.collectibles.seed({ accountId: 'account-buyer-1' });

    const response = await request(app.getHttpServer())
      .get('/api/v1/collectibles')
      .set(auth(token))
      .expect(200);

    const keys = Object.keys(response.body.items[0]);
    expect(keys).not.toContain('platformFeeAmount');
    expect(keys).not.toContain('creatorAmount');
    expect(keys).not.toContain('totalAmount');
  });
});

describe('ご注文の一覧 GET /api/v1/orders', () => {
  it('未認証では読めない', async () => {
    await request(app.getHttpServer()).get('/api/v1/orders').expect(401);
  });

  it('会員は自分の一覧を読める', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/orders')
      .set(auth(actorToken('buyer', 'buyer-1')))
      .expect(200);
    expect(response.body).toEqual({ items: [], nextCursor: null });
  });

  it('一覧の口が詳細に吸われない（`:id` より前に置いてある）', async () => {
    /*
      ⚠️ `@Get(':id')` を先に置くと、`/orders` が `id = ''` として詳細へ
         流れ、404 になる。順序の取り違えを留める。
    */
    const response = await request(app.getHttpServer())
      .get('/api/v1/orders')
      .set(auth(actorToken('buyer', 'buyer-1')));
    expect(response.status).not.toBe(404);
  });

  it('手数料とクリエイター配分を返さない', async () => {
    /*
      ⚠️ **買った方に関係が無く、事業の取り分を外へ晒すことになる。**
         管理側の一覧と同じ形を使い回すと、ここが崩れる。
    */
    const token = actorToken('buyer', 'buyer-1');
    const response = await request(app.getHttpServer())
      .get('/api/v1/orders')
      .set(auth(token))
      .expect(200);
    expect(JSON.stringify(response.body)).not.toContain('platformFee');
  });
});
