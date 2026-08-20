import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createDevToken, DevTokenVerifier, HmacEmailHasher } from '@sengoku/integrations';
import type { Role } from '@sengoku/auth';
import { AppModule } from '../src/app.module';
import { DomainErrorFilter } from '../src/common/domain-error.filter';
import {
  buildHarness,
  sampleArtwork,
  sampleListing,
  TEST_AUDIENCE,
  TEST_EMAIL_PEPPER,
  TEST_ISSUER,
  TEST_NOW,
  TEST_TOKEN_SECRET,
  type TestHarness,
} from './helpers/doubles';

/**
 * 注文の検索と問い合わせ対応（`UD-121`）。
 *
 * ⚠️ ここで確かめたいのは、探せることだけではない。
 *   - **平文のメールアドレスが URL に載らないこと**（`UD-503`）
 *   - **「引けない」と「見つからない」が混ざらないこと**
 *   - **対応メモが追記のみで、消す口が無いこと**
 *   - **`auditor` が購入者を辿れないこと**（広げるのは簡単、狭めるのは難しい）
 */

let app: INestApplication;
let harness: TestHarness;

const LISTING_ID = '11111111-1111-4111-8111-111111111111';
const BUYER_EMAIL = 'buyer@example.com';

function tokenFor(subject: string, email?: string): string {
  return createDevToken(TEST_TOKEN_SECRET, {
    sub: subject,
    iss: TEST_ISSUER,
    aud: TEST_AUDIENCE,
    exp: Math.floor(TEST_NOW.getTime() / 1000) + 3600,
    ...(email === undefined ? {} : { email, email_verified: true }),
  });
}

function actorToken(role: Role, subject = `user-${role}`, email?: string): string {
  harness.accounts.seed(subject, role);
  return tokenFor(subject, email);
}

function seedPurchasable(): void {
  harness.artworks.seed(sampleArtwork({ maxSupply: 3 }));
  harness.listings.seed(sampleListing({ id: LISTING_ID }));
}

async function createOrder(token: string): Promise<{ id: string; orderNumber: string }> {
  const response = await request(app.getHttpServer())
    .post('/api/v1/orders')
    .set('Authorization', `Bearer ${token}`)
    .send({ listingId: LISTING_ID, idempotencyKey: randomUUID() })
    .expect(201);
  return {
    id: response.body.order.id as string,
    orderNumber: response.body.order.orderNumber as string,
  };
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

describe('注文の検索 GET /api/v1/admin/orders', () => {
  it('注文番号の完全一致で絞り込める', async () => {
    seedPurchasable();
    const buyer = actorToken('buyer');
    const order = await createOrder(buyer);
    const operator = actorToken('operator');

    const response = await request(app.getHttpServer())
      .get(`/api/v1/admin/orders?orderNumber=${order.orderNumber}`)
      .set('Authorization', `Bearer ${operator}`)
      .expect(200);

    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].id).toBe(order.id);
  });

  it('末尾 8 文字だけでも絞り込める（電話で控えられるのはそこだけ）', async () => {
    seedPurchasable();
    const buyer = actorToken('buyer');
    const order = await createOrder(buyer);
    const operator = actorToken('operator');
    const suffix = order.orderNumber.slice(-8);

    const response = await request(app.getHttpServer())
      .get(`/api/v1/admin/orders?orderNumber=${suffix}`)
      .set('Authorization', `Bearer ${operator}`)
      .expect(200);

    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].id).toBe(order.id);
  });

  it('金額の範囲で絞り込める', async () => {
    seedPurchasable();
    const buyer = actorToken('buyer');
    await createOrder(buyer);
    const operator = actorToken('operator');

    const hit = await request(app.getHttpServer())
      .get('/api/v1/admin/orders?minTotalAmount=1&maxTotalAmount=100000000')
      .set('Authorization', `Bearer ${operator}`)
      .expect(200);
    expect(hit.body.items.length).toBeGreaterThan(0);

    const miss = await request(app.getHttpServer())
      .get('/api/v1/admin/orders?minTotalAmount=100000000')
      .set('Authorization', `Bearer ${operator}`)
      .expect(200);
    expect(miss.body.items).toHaveLength(0);
  });

  it('作品名の一部で絞り込める（注文時点の名前で引く）', async () => {
    seedPurchasable();
    const buyer = actorToken('buyer');
    await createOrder(buyer);
    const operator = actorToken('operator');
    const title = sampleArtwork().title;

    const response = await request(app.getHttpServer())
      .get(`/api/v1/admin/orders?artworkTitle=${encodeURIComponent(title.slice(0, 2))}`)
      .set('Authorization', `Bearer ${operator}`)
      .expect(200);
    expect(response.body.items.length).toBeGreaterThan(0);
  });

  /**
   * ⚠️ **0 件で返さない。** 0 件だと、探し方が悪いのか本当に無いのかを
   * 利用者が区別できず、同じ検索を繰り返すことになる。
   */
  it('期間が逆なら 400 で断る', async () => {
    const operator = actorToken('operator');
    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/orders?createdFrom=2026-08-19&createdTo=2026-08-01')
      .set('Authorization', `Bearer ${operator}`)
      .expect(400);
    expect(response.body.error.code).toBe('ORDER_SEARCH_INVALID');
  });

  it('注文番号の形が違えば 400 で断る', async () => {
    const operator = actorToken('operator');
    await request(app.getHttpServer())
      .get('/api/v1/admin/orders?orderNumber=%E3%81%82')
      .set('Authorization', `Bearer ${operator}`)
      .expect(400);
  });

  it('日付だけを受け取り、時刻付きは受け付けない（境界の解釈は 1 か所）', async () => {
    const operator = actorToken('operator');
    await request(app.getHttpServer())
      .get('/api/v1/admin/orders?createdFrom=2026-08-19T00:00:00Z')
      .set('Authorization', `Bearer ${operator}`)
      .expect(400);
  });
});

describe('メールからの照合 POST /api/v1/admin/orders/search', () => {
  it('聞き取ったアドレスから注文を辿れる', async () => {
    seedPurchasable();
    // 購入者が「確認済みのメール」を持つトークンでログインすると、
    // ガードが照合値へ変換してアカウントへ残す。
    const buyer = actorToken('buyer', 'user-buyer', BUYER_EMAIL);
    const order = await createOrder(buyer);
    const operator = actorToken('operator');

    const response = await request(app.getHttpServer())
      .post('/api/v1/admin/orders/search')
      .set('Authorization', `Bearer ${operator}`)
      .send({ email: BUYER_EMAIL })
      .expect(200);

    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].id).toBe(order.id);
  });

  it('大文字小文字が違っても辿れる（聞き取って打ち込む運用のため）', async () => {
    seedPurchasable();
    const buyer = actorToken('buyer', 'user-buyer', BUYER_EMAIL);
    await createOrder(buyer);
    const operator = actorToken('operator');

    const response = await request(app.getHttpServer())
      .post('/api/v1/admin/orders/search')
      .set('Authorization', `Bearer ${operator}`)
      .send({ email: 'Buyer@Example.COM' })
      .expect(200);
    expect(response.body.items).toHaveLength(1);
  });

  it('別のアドレスでは辿れない', async () => {
    seedPurchasable();
    const buyer = actorToken('buyer', 'user-buyer', BUYER_EMAIL);
    await createOrder(buyer);
    const operator = actorToken('operator');

    const response = await request(app.getHttpServer())
      .post('/api/v1/admin/orders/search')
      .set('Authorization', `Bearer ${operator}`)
      .send({ email: 'someone-else@example.com' })
      .expect(200);
    expect(response.body.items).toHaveLength(0);
  });

  /**
   * ⚠️ **`UD-121` の要。** 鍵の無い配備で「見つかりません」と答えると、
   * 問い合わせてきた方に事実でないことを伝えることになる。
   */
  it('照合の鍵が無い配備では「引けない」と返す（「見つからない」にしない）', async () => {
    const withoutPepper = { ...harness, emailHasher: new HmacEmailHasher(null) };
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(withoutPepper)],
    }).compile();
    const other = moduleRef.createNestApplication();
    other.useGlobalFilters(new DomainErrorFilter());
    await other.init();

    const operator = actorToken('operator');
    const response = await request(other.getHttpServer())
      .post('/api/v1/admin/orders/search')
      .set('Authorization', `Bearer ${operator}`)
      .send({ email: BUYER_EMAIL })
      .expect(503);
    expect(response.body.error.code).toBe('EMAIL_LOOKUP_UNAVAILABLE');

    await other.close();
  });

  it('照合を使ったことは証跡に残るが、アドレスも照合値も残らない', async () => {
    seedPurchasable();
    const buyer = actorToken('buyer', 'user-buyer', BUYER_EMAIL);
    await createOrder(buyer);
    const operator = actorToken('operator');

    await request(app.getHttpServer())
      .post('/api/v1/admin/orders/search')
      .set('Authorization', `Bearer ${operator}`)
      .send({ email: BUYER_EMAIL })
      .expect(200);

    const entry = harness.audit.entries.find((item) => item.action === 'order.buyer_lookup');
    expect(entry).toBeDefined();
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain('buyer@example.com');
    // 照合値そのものも残さない。同じ鍵で変換すれば一致を確かめられる。
    const hashed = new HmacEmailHasher(TEST_EMAIL_PEPPER).hash(BUYER_EMAIL) ?? '';
    expect(serialized).not.toContain(hashed);
  });

  /**
   * ⚠️ **`auditor` には渡していない。** 一覧を見ることと、人に紐づけて
   * 注文の有無を答えられることは別の力。広げるのは簡単、狭めるのは難しい。
   */
  it('auditor は購入者を辿れない（一覧は見られる）', async () => {
    const auditor = actorToken('auditor');
    await request(app.getHttpServer())
      .get('/api/v1/admin/orders')
      .set('Authorization', `Bearer ${auditor}`)
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/v1/admin/orders/search')
      .set('Authorization', `Bearer ${auditor}`)
      .send({ email: BUYER_EMAIL })
      .expect(403);
  });

  it('購入者は使えない', async () => {
    const buyer = actorToken('buyer');
    await request(app.getHttpServer())
      .post('/api/v1/admin/orders/search')
      .set('Authorization', `Bearer ${buyer}`)
      .send({ email: BUYER_EMAIL })
      .expect(403);
  });
});

describe('注文の経過 GET /api/v1/admin/orders/:id/timeline', () => {
  it('古い順に並ぶ', async () => {
    seedPurchasable();
    const buyer = actorToken('buyer');
    const order = await createOrder(buyer);
    const operator = actorToken('operator');

    const response = await request(app.getHttpServer())
      .get(`/api/v1/admin/orders/${order.id}/timeline`)
      .set('Authorization', `Bearer ${operator}`)
      .expect(200);

    const times = response.body.entries.map((entry: { at: string }) => Date.parse(entry.at));
    expect([...times].sort((a: number, b: number) => a - b)).toEqual(times);
    expect(response.body.entries[0].kind).toBe('order_created');
  });

  it('存在しない注文は 404', async () => {
    const operator = actorToken('operator');
    await request(app.getHttpServer())
      .get(`/api/v1/admin/orders/${randomUUID()}/timeline`)
      .set('Authorization', `Bearer ${operator}`)
      .expect(404);
  });
});

describe('対応メモ /api/v1/admin/orders/:id/notes', () => {
  it('足したメモが一覧と経過の両方に出る', async () => {
    seedPurchasable();
    const buyer = actorToken('buyer');
    const order = await createOrder(buyer);
    const operator = actorToken('operator');

    await request(app.getHttpServer())
      .post(`/api/v1/admin/orders/${order.id}/notes`)
      .set('Authorization', `Bearer ${operator}`)
      .send({ body: 'お電話にてご案内しました。' })
      .expect(201);

    const notes = await request(app.getHttpServer())
      .get(`/api/v1/admin/orders/${order.id}/notes`)
      .set('Authorization', `Bearer ${operator}`)
      .expect(200);
    expect(notes.body.notes).toHaveLength(1);
    expect(notes.body.notes[0].body).toBe('お電話にてご案内しました。');

    const timeline = await request(app.getHttpServer())
      .get(`/api/v1/admin/orders/${order.id}/timeline`)
      .set('Authorization', `Bearer ${operator}`)
      .expect(200);
    expect(
      timeline.body.entries.some((entry: { kind: string }) => entry.kind === 'support_note'),
    ).toBe(true);
  });

  /** ⚠️ `UD-503` を守る要。保持しないと決めた値を、別の表へ書き写させない。 */
  it('平文のメールアドレスを含むメモは断る', async () => {
    seedPurchasable();
    const buyer = actorToken('buyer');
    const order = await createOrder(buyer);
    const operator = actorToken('operator');

    const response = await request(app.getHttpServer())
      .post(`/api/v1/admin/orders/${order.id}/notes`)
      .set('Authorization', `Bearer ${operator}`)
      .send({ body: 'ご連絡先は buyer@example.com とのこと。' })
      .expect(400);
    expect(response.body.error.code).toBe('ORDER_NOTE_INVALID');
  });

  it('証跡には「誰がいつ書いたか」しか残さない（本文を残さない）', async () => {
    seedPurchasable();
    const buyer = actorToken('buyer');
    const order = await createOrder(buyer);
    const operator = actorToken('operator');
    const body = '返金のご相談を承りました。';

    await request(app.getHttpServer())
      .post(`/api/v1/admin/orders/${order.id}/notes`)
      .set('Authorization', `Bearer ${operator}`)
      .send({ body })
      .expect(201);

    const entry = harness.audit.entries.find((item) => item.action === 'order.note_added');
    expect(entry).toBeDefined();
    expect(JSON.stringify(entry)).not.toContain(body);
  });

  /**
   * ⚠️ **消す口も直す口も無い。** 用意した瞬間に「間違えたから消して」が
   * 始まり、揉めたときに参照できる記録が残らなくなる。
   */
  it('メモを消す口も直す口も無い', async () => {
    seedPurchasable();
    const buyer = actorToken('buyer');
    const order = await createOrder(buyer);
    const operator = actorToken('operator');

    await request(app.getHttpServer())
      .post(`/api/v1/admin/orders/${order.id}/notes`)
      .set('Authorization', `Bearer ${operator}`)
      .send({ body: '受付しました。' })
      .expect(201);

    const notes = await request(app.getHttpServer())
      .get(`/api/v1/admin/orders/${order.id}/notes`)
      .set('Authorization', `Bearer ${operator}`)
      .expect(200);
    const noteId = notes.body.notes[0].id as string;

    await request(app.getHttpServer())
      .delete(`/api/v1/admin/orders/${order.id}/notes/${noteId}`)
      .set('Authorization', `Bearer ${operator}`)
      .expect(404);
    await request(app.getHttpServer())
      .patch(`/api/v1/admin/orders/${order.id}/notes/${noteId}`)
      .set('Authorization', `Bearer ${operator}`)
      .send({ body: '書き換え' })
      .expect(404);
  });

  it('auditor は書けない（読めるだけ）', async () => {
    seedPurchasable();
    const buyer = actorToken('buyer');
    const order = await createOrder(buyer);
    const auditor = actorToken('auditor');

    await request(app.getHttpServer())
      .get(`/api/v1/admin/orders/${order.id}/notes`)
      .set('Authorization', `Bearer ${auditor}`)
      .expect(200);
    await request(app.getHttpServer())
      .post(`/api/v1/admin/orders/${order.id}/notes`)
      .set('Authorization', `Bearer ${auditor}`)
      .send({ body: '監査からの記入' })
      .expect(403);
  });

  it('存在しない注文へは足せない', async () => {
    const operator = actorToken('operator');
    await request(app.getHttpServer())
      .post(`/api/v1/admin/orders/${randomUUID()}/notes`)
      .set('Authorization', `Bearer ${operator}`)
      .send({ body: '受付しました。' })
      .expect(404);
  });
});
