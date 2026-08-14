import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type {
  ClaimConfirmOutcome,
  ClaimLookupResult,
  ClaimRepositoryPort,
  EntitlementStatus,
  WalletDeliveryStatus,
} from '@sengoku/domain';
import {
  DevTokenVerifier,
  InMemoryNonceStore,
  SenNoKuniHmacVerifier,
  Sha256ClaimTokenService,
  signRequest,
} from '@sengoku/integrations';
import { createLogger } from '@sengoku/observability';
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

const KEY_ID = 'wallet-test';
const SECRET = 'wallet-test-secret';
const PURCHASER_CU = 'cu_0123456789abcdef0123456789abcdef';
const OTHER_CU = 'cu_fedcba9876543210fedcba9876543210';
const TOKEN = 'claim-token-abc';

const tokens = new Sha256ClaimTokenService();

/**
 * Claim の保管庫（テスト用）。
 *
 * ⚠️ **確定は「現在の状態を条件にした更新」で行う。**
 * ここを「読んで判定してから書く」にすると、テストだけが通って
 * 本番の競合を見逃す。実装（条件付き UPDATE）と同じ性質にしておく。
 */
class FakeClaimRepository implements ClaimRepositoryPort {
  private row: {
    id: string;
    status: EntitlementStatus;
    deliveryStatus: WalletDeliveryStatus;
    expiresAt: Date | null;
    purchaserCommonUserId: string | null;
    claimedByCommonUserId: string | null;
  };

  constructor(
    overrides: Partial<FakeClaimRepository['row']> = {},
    private readonly tokenHash = tokens.hash(TOKEN),
  ) {
    this.row = {
      id: 'ent-1',
      status: 'issued',
      deliveryStatus: 'not_started',
      expiresAt: null,
      purchaserCommonUserId: PURCHASER_CU,
      claimedByCommonUserId: null,
      ...overrides,
    };
  }

  findByTokenHash(claimTokenHash: string): Promise<ClaimLookupResult | null> {
    if (claimTokenHash !== this.tokenHash) {
      return Promise.resolve(null);
    }
    return Promise.resolve({
      entitlement: { ...this.row },
      purchaserAccountId: 'account-1',
      cardName: '天下布武の陣羽織',
    });
  }

  confirmClaim(input: { commonUserId: string }): Promise<ClaimConfirmOutcome> {
    if (this.row.status !== 'issued') {
      return Promise.resolve({ kind: 'raced' });
    }
    this.row = {
      ...this.row,
      status: 'claimed',
      deliveryStatus: 'pending',
      claimedByCommonUserId: input.commonUserId,
    };
    return Promise.resolve({ kind: 'claimed' });
  }
}

let app: INestApplication;
let harness: TestHarness;
let claims: FakeClaimRepository;

/** 署名付きの要求を組み立てる。**本文は署名した文字列をそのまま送る。** */
function signed(method: 'GET' | 'POST', path: string, rawBody = '', nonce = `n-${nonceSeq++}`) {
  const timestamp = String(Math.floor(TEST_NOW.getTime() / 1000));
  const signature = signRequest(SECRET, {
    keyId: KEY_ID,
    timestamp,
    nonce,
    method,
    path,
    rawBody,
  });
  return {
    'x-sennokuni-key-id': KEY_ID,
    'x-sennokuni-timestamp': timestamp,
    'x-sennokuni-nonce': nonce,
    'x-sennokuni-signature': signature,
  };
}

let nonceSeq = 1;

async function boot(
  options: { enabled?: boolean; repo?: FakeClaimRepository } = {},
): Promise<void> {
  claims = options.repo ?? new FakeClaimRepository();
  harness = buildHarness(
    new DevTokenVerifier({
      secret: TEST_TOKEN_SECRET,
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
      now: () => TEST_NOW,
    }),
  );
  const enabled = options.enabled ?? true;
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.register({
        ...harness,
        claim: {
          enabled,
          claims,
          tokens,
          verifier: enabled
            ? new SenNoKuniHmacVerifier({
                secrets: { [KEY_ID]: SECRET },
                nonces: new InMemoryNonceStore(),
              })
            : null,
          logger: createLogger({ service: 'test', level: 'fatal' }),
        },
      }),
    ],
  }).compile();
  app = moduleRef.createNestApplication({ rawBody: true });
  app.useGlobalFilters(new DomainErrorFilter());
  await app.init();
}

afterEach(async () => {
  await app?.close();
});

describe('Claim API の署名検証', () => {
  beforeEach(async () => {
    await boot();
  });

  it('署名が無ければ 401（本文に理由を含めない）', async () => {
    const response = await request(app.getHttpServer()).get(`/api/collectible-claims/${TOKEN}`);
    expect(response.status).toBe(401);
    expect(JSON.stringify(response.body)).not.toMatch(/nonce|timestamp|signature|key/i);
  });

  it('署名が違えば 403', async () => {
    const path = `/api/collectible-claims/${TOKEN}`;
    const headers = signed('GET', path);
    const response = await request(app.getHttpServer())
      .get(path)
      .set({ ...headers, 'x-sennokuni-signature': 'sha256=deadbeef' });
    expect(response.status).toBe(403);
  });

  it('鍵IDが未知なら 403（存在する鍵を教えない）', async () => {
    const path = `/api/collectible-claims/${TOKEN}`;
    const response = await request(app.getHttpServer())
      .get(path)
      .set({ ...signed('GET', path), 'x-sennokuni-key-id': 'unknown-key' });
    expect(response.status).toBe(403);
  });

  it('時刻が許容範囲の外なら 403', async () => {
    const path = `/api/collectible-claims/${TOKEN}`;
    const stale = String(Math.floor(TEST_NOW.getTime() / 1000) - 3600);
    const signature = signRequest(SECRET, {
      keyId: KEY_ID,
      timestamp: stale,
      nonce: 'n-stale',
      method: 'GET',
      path,
      rawBody: '',
    });
    const response = await request(app.getHttpServer()).get(path).set({
      'x-sennokuni-key-id': KEY_ID,
      'x-sennokuni-timestamp': stale,
      'x-sennokuni-nonce': 'n-stale',
      'x-sennokuni-signature': signature,
    });
    expect(response.status).toBe(403);
  });

  it('同じ nonce の 2 回目は 403（リプレイ拒否）', async () => {
    const path = `/api/collectible-claims/${TOKEN}`;
    const headers = signed('GET', path, '', 'n-replay');
    expect((await request(app.getHttpServer()).get(path).set(headers)).status).toBe(200);
    expect((await request(app.getHttpServer()).get(path).set(headers)).status).toBe(403);
  });

  it('本文を1文字でも変えると 403（生の本文で検証している）', async () => {
    // ⚠️ ここが通ってしまうなら、本文が署名の対象になっていない。
    const path = `/api/collectible-claims/${TOKEN}/confirm`;
    const rawBody = JSON.stringify({ common_user_id: PURCHASER_CU });
    const headers = signed('POST', path, rawBody);
    const response = await request(app.getHttpServer())
      .post(path)
      .set({ ...headers, 'content-type': 'application/json' })
      .send(JSON.stringify({ common_user_id: OTHER_CU }));
    expect(response.status).toBe(403);
  });
});

describe('Claim API が無効なとき', () => {
  beforeEach(async () => {
    await boot({ enabled: false });
  });

  it('404 を返す（機能を止めてあることも伏せる）', async () => {
    const path = `/api/collectible-claims/${TOKEN}`;
    const response = await request(app.getHttpServer()).get(path).set(signed('GET', path));
    expect(response.status).toBe(404);
  });
});

describe('GET の応答', () => {
  it('status / card_name / expires_at だけを返す', async () => {
    await boot();
    const path = `/api/collectible-claims/${TOKEN}`;
    const response = await request(app.getHttpServer()).get(path).set(signed('GET', path));
    expect(response.status).toBe(200);
    // ✅ 画像 URL とシリアル番号は返さない（UD-508 をブロッカーから外すため）。
    expect(Object.keys(response.body).sort()).toEqual(['card_name', 'expires_at', 'status']);
    expect(response.body.status).toBe('PENDING');
  });

  it('知らないトークンは 404', async () => {
    await boot();
    const path = '/api/collectible-claims/unknown-token';
    const response = await request(app.getHttpServer()).get(path).set(signed('GET', path));
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('CLAIM_TOKEN_INVALID');
  });
});

/** `POST` を署名付きで送る。 */
async function postConfirm(commonUserId: string, token = TOKEN) {
  const path = `/api/collectible-claims/${token}/confirm`;
  const rawBody = JSON.stringify({ common_user_id: commonUserId });
  return request(app.getHttpServer())
    .post(path)
    .set({ ...signed('POST', path, rawBody), 'content-type': 'application/json' })
    .send(rawBody);
}

describe('POST の応答', () => {
  it('受理すると 202 と DELIVERY_PENDING', async () => {
    await boot();
    const response = await postConfirm(PURCHASER_CU);
    expect(response.status).toBe(202);
    expect(response.body).toEqual({ status: 'DELIVERY_PENDING' });
  });

  it('購入者が未解決なら 202 と PENDING（失敗にしない）', async () => {
    await boot({ repo: new FakeClaimRepository({ purchaserCommonUserId: null }) });
    const response = await postConfirm(PURCHASER_CU);
    expect(response.status).toBe(202);
    expect(response.body).toEqual({ status: 'PENDING', reason: 'common_user_pending' });
  });

  it('別人なら 409 COMMON_USER_MISMATCH', async () => {
    await boot();
    const response = await postConfirm(OTHER_CU);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('COMMON_USER_MISMATCH');
  });

  it('期限切れなら 410 CLAIM_EXPIRED', async () => {
    await boot({
      repo: new FakeClaimRepository({ expiresAt: new Date(TEST_NOW.getTime() - 1000) }),
    });
    const response = await postConfirm(PURCHASER_CU);
    expect(response.status).toBe(410);
    expect(response.body.error.code).toBe('CLAIM_EXPIRED');
  });

  it('取り消し済みなら 409 CLAIM_REVOKED', async () => {
    await boot({ repo: new FakeClaimRepository({ status: 'revoked' }) });
    const response = await postConfirm(PURCHASER_CU);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('CLAIM_REVOKED');
  });

  it('同じ本人が送り直しても、受取権は 1 回しか使われない', async () => {
    await boot();
    const first = await postConfirm(PURCHASER_CU);
    expect(first.status).toBe(202);
    const second = await postConfirm(PURCHASER_CU);
    // 2 回目も成功として答えるが、状態は進まない。
    expect(second.status).toBe(202);
    expect(second.body.status).toBe('DELIVERY_PENDING');
  });

  it('確定後の GET は DELIVERY_PENDING（DELIVERED にしない）', async () => {
    await boot();
    await postConfirm(PURCHASER_CU);
    const path = `/api/collectible-claims/${TOKEN}`;
    const response = await request(app.getHttpServer()).get(path).set(signed('GET', path));
    // 受け取っただけで「届いた」と答えない。
    expect(response.body.status).toBe('DELIVERY_PENDING');
  });

  it('形式の違う common_user_id は 400', async () => {
    await boot();
    const response = await postConfirm('user-123');
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('エラーは全 API 共通の封筒で返す', async () => {
    await boot();
    const response = await postConfirm(OTHER_CU);
    // ✅ Claim API だけ独自形式にしない。
    expect(response.body).toHaveProperty('error.code');
    expect(response.body).toHaveProperty('error.message');
  });
});
