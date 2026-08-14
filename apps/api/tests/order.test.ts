import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { CreatedOrder, PurchaseTarget } from '@sengoku/database';
import type { OrderDraft } from '@sengoku/domain';
import { createDevToken, DevTokenVerifier } from '@sengoku/integrations';
import type { Role } from '@sengoku/auth';
import type { OrderStore } from '../src/order/order.service';
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

const LISTING_ID = '11111111-1111-4111-8111-111111111111';

/**
 * 注文の保管庫（テスト用）。
 *
 * ⚠️ **同じ冪等キーでは作り直さない**性質を、実装と同じにしておく。
 * ここを緩めると、テストだけが通って本番の二重注文を見逃す。
 */
class FakeOrderStore implements OrderStore {
  private readonly byKey = new Map<string, CreatedOrder>();
  /** 押さえている数。**初期値は与えられた在庫から引き継ぐ。** */
  reservedCount: number;
  createdCount = 0;

  constructor(private target: PurchaseTarget | null = defaultTarget()) {
    this.reservedCount = target?.artwork.counters.reservedCount ?? 0;
  }

  findPurchaseTarget(listingId: string): Promise<PurchaseTarget | null> {
    if (this.target === null || listingId !== this.target.listing.id) {
      return Promise.resolve(null);
    }
    return Promise.resolve({
      ...this.target,
      artwork: {
        ...this.target.artwork,
        counters: { ...this.target.artwork.counters, reservedCount: this.reservedCount },
      },
    });
  }

  createWithReservation(input: {
    draft: OrderDraft;
    idempotencyKey: string;
    quantity: number;
  }): Promise<CreatedOrder> {
    const existing = this.byKey.get(input.idempotencyKey);
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }
    this.createdCount += 1;
    this.reservedCount += input.quantity;
    const order: CreatedOrder = {
      id: `ord-${this.createdCount}`,
      status: 'pending',
      totalAmount: input.draft.total.amountMinor,
      totalCurrency: input.draft.total.currency,
      reservedUntil: input.draft.reservedUntil,
    };
    this.byKey.set(input.idempotencyKey, order);
    return Promise.resolve(order);
  }
}

function defaultTarget(overrides: Partial<PurchaseTarget['artwork']> = {}): PurchaseTarget {
  return {
    artwork: {
      id: 'art-1',
      slug: 'tenka-fubu',
      title: '天下布武の陣羽織',
      status: 'published',
      counters: { maxSupply: 10, reservedCount: 0, issuedCount: 0 },
      ...overrides,
    },
    listing: {
      id: LISTING_ID,
      artworkId: 'art-1',
      priceAmount: 1000,
      priceCurrency: 'JPY',
      maxQuantityPerOrder: 3,
      status: 'active',
      startsAt: null,
      endsAt: null,
      displayOrder: 0,
    },
  };
}

let app: INestApplication;
let harness: TestHarness;
let store: FakeOrderStore;

function tokenFor(role: Role, subject = 'buyer-1'): string {
  harness.accounts.seed(subject, role);
  return createDevToken(TEST_TOKEN_SECRET, {
    sub: subject,
    iss: TEST_ISSUER,
    aud: TEST_AUDIENCE,
    exp: Math.floor(TEST_NOW.getTime() / 1000) + 3600,
  });
}

async function boot(target?: PurchaseTarget | null): Promise<void> {
  harness = buildHarness(
    new DevTokenVerifier({
      secret: TEST_TOKEN_SECRET,
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
      now: () => TEST_NOW,
    }),
  );
  store = new FakeOrderStore(target === undefined ? defaultTarget() : target);
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.register({ ...harness, orders: store })],
  }).compile();
  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new DomainErrorFilter());
  await app.listen(0);
}

afterEach(async () => {
  await app?.close();
});

/** 注文を送る。冪等キーは既定で毎回新しくする。 */
let keySeq = 1;
async function postOrder(
  token: string,
  body: unknown = { listing_id: LISTING_ID, quantity: 1 },
  idempotencyKey?: string | null,
) {
  const req = request(app.getHttpServer())
    .post('/api/v1/orders')
    .set('authorization', `Bearer ${token}`);
  if (idempotencyKey !== null) {
    req.set('idempotency-key', idempotencyKey ?? `order-key-${keySeq++}`);
  }
  return req.send(body as object);
}

describe('注文の作成', () => {
  beforeEach(async () => {
    await boot();
  });

  it('購入者なら注文できる', async () => {
    const response = await postOrder(tokenFor('buyer'));
    expect(response.status).toBe(201);
    expect(response.body.total_amount).toBe(1000);
    expect(response.body.status).toBe('pending');
    expect(response.body.currency).toBe('JPY');
  });

  it('数量ぶんの金額になる', async () => {
    const response = await postOrder(tokenFor('buyer'), {
      listing_id: LISTING_ID,
      quantity: 3,
    });
    expect(response.status).toBe(201);
    expect(response.body.total_amount).toBe(3000);
  });

  it('仮引当の期限を返す', async () => {
    const response = await postOrder(tokenFor('buyer'));
    expect(typeof response.body.reserved_until).toBe('string');
  });

  it('未認証では注文できない', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('idempotency-key', 'order-key-anon')
      .send({ listing_id: LISTING_ID, quantity: 1 });
    expect(response.status).toBe(401);
  });

  it('運営は注文できない（購入は購入者の操作）', async () => {
    const response = await postOrder(tokenFor('operator', 'op-1'));
    expect(response.status).toBe(403);
  });

  describe('冪等キー', () => {
    it('無ければ 400', async () => {
      const response = await postOrder(tokenFor('buyer'), undefined, null);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('同じキーの再送で二重に注文しない', async () => {
      // ⚠️ 注文は取り返しがつかない。応答だけ失われた再送で
      //    もう一度買わせない。
      const token = tokenFor('buyer');
      const first = await postOrder(token, undefined, 'order-key-same');
      const second = await postOrder(token, undefined, 'order-key-same');
      expect(first.status).toBe(201);
      expect(second.body.order_id).toBe(first.body.order_id);
      expect(store.createdCount).toBe(1);
      expect(store.reservedCount).toBe(1);
    });
  });

  describe('入力の検証', () => {
    it('数量 0 を拒否する', async () => {
      const response = await postOrder(tokenFor('buyer'), {
        listing_id: LISTING_ID,
        quantity: 0,
      });
      expect(response.status).toBe(400);
    });

    it('出品ごとの上限を超える数量を拒否する', async () => {
      const response = await postOrder(tokenFor('buyer'), {
        listing_id: LISTING_ID,
        quantity: 4,
      });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVALID_QUANTITY');
    });

    it('出品IDの形式が違えば 400', async () => {
      const response = await postOrder(tokenFor('buyer'), {
        listing_id: 'not-a-uuid',
        quantity: 1,
      });
      expect(response.status).toBe(400);
    });
  });

  it('エラーは全 API 共通の封筒で返す', async () => {
    const response = await postOrder(tokenFor('buyer'), {
      listing_id: LISTING_ID,
      quantity: 4,
    });
    expect(response.body).toHaveProperty('error.code');
    expect(response.body).toHaveProperty('error.message');
  });
});

describe('買えない出品', () => {
  it('存在しない出品は 404（見つからないとして扱う）', async () => {
    await boot(null);
    const response = await postOrder(tokenFor('buyer'));
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('ARTWORK_NOT_AVAILABLE');
  });

  it('未公開の作品も 404（存在を漏らさない）', async () => {
    // ⚠️ 状態を分けて答えると、未公開作品の存在を外から探れる。
    await boot(defaultTarget({ status: 'draft' }));
    const response = await postOrder(tokenFor('buyer'));
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('ARTWORK_NOT_AVAILABLE');
  });

  it('在庫が尽きていれば 409', async () => {
    await boot(defaultTarget({ counters: { maxSupply: 1, reservedCount: 1, issuedCount: 0 } }));
    const response = await postOrder(tokenFor('buyer'));
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('INSUFFICIENT_SUPPLY');
  });
});
