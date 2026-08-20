import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type {
  ClaimConfirmOutcome,
  ClaimDeliveryEnqueue,
  ClaimLookupResult,
  EntitlementStatus,
  ReissuableEntitlement,
  WalletDeliveryStatus,
} from '@sengoku/domain';
import {
  DevTokenVerifier,
  InMemoryNonceStore,
  InMemoryRateLimiter,
  InMemoryStorage,
  SenNoKuniHmacVerifier,
  Sha256ClaimTokenService,
} from '@sengoku/integrations';
import { createLogger } from '@sengoku/observability';
import type { ClaimTokenRotationSource } from '../src/claim/reissue.service';
import { AppModule } from '../src/app.module';
import { DomainErrorFilter } from '../src/common/domain-error.filter';
import {
  buildHarness,
  TEST_AUDIENCE,
  TEST_INTERNAL_JOB_TOKEN,
  TEST_ISSUER,
  TEST_NOW,
  TEST_TOKEN_SECRET,
  type TestHarness,
} from './helpers/doubles';

/**
 * Wallet への自動配送（P0-2）。
 *
 * ⚠️ この組の主題は 5 つ。
 *   1. **登録済みの方には、受取URLを開かせずに届くこと。**
 *   2. **未登録の方を失敗として数えないこと。** 登録が済めば次の掃き出しが拾う。
 *   3. **あとから登録した方の配送が再開すること**（新しい合図を作らずに）。
 *   4. **重なって走っても二重に届かないこと。**
 *   5. **Wallet へ繋いでいない配備でも、口が 0 件を返して動くこと。**
 */

const PURCHASER_CU = 'cu_0123456789abcdef0123456789abcdef';
const JOB_PATH = '/api/v1/internal/jobs/deliver-entitlements';
const tokens = new Sha256ClaimTokenService();

/**
 * 画像の公開URLを返す保管庫（テスト用）。
 *
 * ⚠️ **`InMemoryStorage` のままでは配送できない。** あちらは `/media/...` と
 * いう相対パスを返し、Wallet へ送る本文の検証（長期に参照できる https のみ）で
 * 落ちる。**これは代替実装の都合ではなく本番の要件**で、実際、画像の公開URLを
 * 用意していない配備では配送を有効にできない。
 */
class HttpsStorage extends InMemoryStorage {
  override publicUrl(key: string): string {
    return `https://media.example.test/${key}`;
  }
}

/** Claim の保管庫（テスト用）。⚠️ 確定は現在の状態を条件にした更新と同じ性質にする。 */
class FakeClaims implements ClaimTokenRotationSource {
  private row: {
    id: string;
    status: EntitlementStatus;
    deliveryStatus: WalletDeliveryStatus;
    expiresAt: Date | null;
    purchaserCommonUserId: string | null;
    claimedByCommonUserId: string | null;
  };

  /** 行列へ載った本文。⚠️ 平文の受取トークンは含まれない。 */
  readonly enqueued: ClaimDeliveryEnqueue[] = [];

  /** 受取が成立した回数。二重受取が起きていないかを見る。 */
  claimCount = 0;

  constructor(overrides: Partial<FakeClaims['row']> = {}) {
    this.row = {
      id: 'ent-1',
      status: 'issued',
      deliveryStatus: 'not_started',
      expiresAt: null,
      // 既定は「まだ受取用のウォレットを登録していない」。
      purchaserCommonUserId: null,
      claimedByCommonUserId: null,
      ...overrides,
    };
  }

  /** 受取用のウォレットが結び付いた状況を作る。 */
  registerWallet(commonUserId = PURCHASER_CU): void {
    this.row = { ...this.row, purchaserCommonUserId: commonUserId };
  }

  get status(): EntitlementStatus {
    return this.row.status;
  }

  private lookup(): ClaimLookupResult {
    return {
      entitlement: { ...this.row },
      purchaserAccountId: 'account-1',
      cardName: '天下布武の陣羽織',
      snapshot: {
        orderId: 'order-1',
        orderLineId: 'line-1',
        artworkId: 'artwork-1',
        serialNo: 7,
        artworkTitle: '天下布武の陣羽織',
        artworkDescription: '説明文',
        imageKey: 'artworks/sample.png',
        imageHash: `sha256:${'a'.repeat(64)}`,
      },
    };
  }

  findByTokenHash(claimTokenHash: string): Promise<ClaimLookupResult | null> {
    return Promise.resolve(claimTokenHash === tokens.hash('unused') ? this.lookup() : null);
  }

  findForAutoDelivery(entitlementId: string): Promise<ClaimLookupResult | null> {
    return Promise.resolve(entitlementId === this.row.id ? this.lookup() : null);
  }

  listAutoDeliverable(limit: number): Promise<ClaimLookupResult[]> {
    // ⚠️ 実装と同じ条件。ウォレットが結び付いている分だけ拾う。
    if (limit < 1 || this.row.status !== 'issued' || this.row.purchaserCommonUserId === null) {
      return Promise.resolve([]);
    }
    return Promise.resolve([this.lookup()]);
  }

  findForReissue(): Promise<ReissuableEntitlement | null> {
    // 再発行はこの組の関心事ではない。⚠️ 通してしまわないよう `null` を返す。
    return Promise.resolve(null);
  }

  currentTokenHash(): Promise<string | null> {
    return Promise.resolve(null);
  }

  rotateClaimToken(): Promise<boolean> {
    return Promise.resolve(false);
  }

  confirmClaim(input: {
    commonUserId: string;
    delivery?: ClaimDeliveryEnqueue | undefined;
  }): Promise<ClaimConfirmOutcome> {
    if (this.row.status !== 'issued') {
      return Promise.resolve({ kind: 'raced' });
    }
    this.claimCount += 1;
    this.row = {
      ...this.row,
      status: 'claimed',
      deliveryStatus: 'pending',
      claimedByCommonUserId: input.commonUserId,
    };
    if (input.delivery !== undefined) {
      this.enqueued.push(input.delivery);
    }
    return Promise.resolve({ kind: 'claimed' });
  }
}

let app: INestApplication;
let harness: TestHarness;
let claims: FakeClaims;

async function boot(options: { deliveryEnabled?: boolean; repo?: FakeClaims } = {}): Promise<void> {
  claims = options.repo ?? new FakeClaims();
  harness = buildHarness(
    new DevTokenVerifier({
      secret: TEST_TOKEN_SECRET,
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
      now: () => TEST_NOW,
    }),
  );
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.register({
        ...harness,
        // ⚠️ 画像の公開URLが要る（上記）。
        storage: new HttpsStorage(),
        claim: {
          enabled: true,
          claims,
          tokens,
          verifier: new SenNoKuniHmacVerifier({
            secrets: { 'wallet-test': 'wallet-test-secret' },
            nonces: new InMemoryNonceStore(),
          }),
          logger: createLogger({ service: 'test', level: 'fatal' }),
          rateLimiter: new InMemoryRateLimiter(),
          claimBaseUrl: 'https://example.test/claims',
          deliveryEnabled: options.deliveryEnabled ?? true,
          getPerMinute: 3000,
          postPerMinute: 300,
        },
      }),
    ],
  }).compile();
  app = moduleRef.createNestApplication({ rawBody: true });
  app.useGlobalFilters(new DomainErrorFilter());
  await app.init();
}

function sweep() {
  return request(app.getHttpServer())
    .post(JOB_PATH)
    .set('x-internal-job-token', TEST_INTERNAL_JOB_TOKEN);
}

afterEach(async () => {
  await app?.close();
});

describe('掃き出しの口を守る', () => {
  beforeEach(async () => {
    await boot();
  });

  it('合言葉が無ければ通さない', async () => {
    await request(app.getHttpServer()).post(JOB_PATH).expect(401);
  });

  it('合言葉が違えば通さない', async () => {
    await request(app.getHttpServer())
      .post(JOB_PATH)
      .set('x-internal-job-token', 'wrong')
      .expect(401);
  });

  it('受取権IDも購入者も返さない（監視の数値であって名簿ではない）', async () => {
    const response = await sweep().expect(200);
    expect(Object.keys(response.body).sort()).toEqual([
      'deliveredCount',
      'failedCount',
      'pickedCount',
      'skippedCount',
    ]);
  });
});

describe('登録済みの方には、待たせずに届ける', () => {
  beforeEach(async () => {
    await boot();
  });

  it('受取URLを開かせずに、行列へ載る', async () => {
    claims.registerWallet();
    const response = await sweep().expect(200);

    expect(response.body).toMatchObject({ pickedCount: 1, deliveredCount: 1, failedCount: 0 });
    expect(claims.status).toBe('claimed');
    expect(claims.enqueued).toHaveLength(1);
  });

  it('届け先は購入者ご本人の値になる', async () => {
    claims.registerWallet();
    await sweep().expect(200);
    // ⚠️ 届け先を外から渡せる形にしない。他人の Wallet へ届く道になる。
    expect(claims.enqueued[0]?.payload).toContain(PURCHASER_CU);
  });

  it('届けたことを監査ログへ残す', async () => {
    claims.registerWallet();
    await sweep().expect(200);
    expect(harness.audit.actions()).toContain('entitlement.auto_delivered');
  });

  it('監査ログに共通顧客IDを残さない', async () => {
    claims.registerWallet();
    await sweep().expect(200);
    const entry = harness.audit.entries.find((row) => row.action === 'entitlement.auto_delivered');
    // ⚠️ 外部の識別子を人へ結び付けた名簿にしない。受取権IDから辿れる。
    expect(JSON.stringify(entry?.summary)).not.toContain(PURCHASER_CU);
  });
});

describe('まだ登録していない方', () => {
  beforeEach(async () => {
    await boot();
  });

  it('拾わないし、失敗にもしない', async () => {
    /*
      ⚠️ **失敗として数えると、登録前の方が居るだけで監視が赤くなる。**
         本当の異常が埋もれる。
    */
    const response = await sweep().expect(200);
    expect(response.body).toEqual({
      pickedCount: 0,
      deliveredCount: 0,
      skippedCount: 0,
      failedCount: 0,
    });
    expect(claims.status).toBe('issued');
  });

  it('あとから登録すると、次の掃き出しで届く（配送が再開する）', async () => {
    // ⚠️ ここが P0-2 の眼目。登録完了の合図を別に作らずに再開する。
    await sweep().expect(200);
    expect(claims.status).toBe('issued');

    claims.registerWallet();
    const after = await sweep().expect(200);
    expect(after.body).toMatchObject({ deliveredCount: 1 });
    expect(claims.status).toBe('claimed');
  });
});

describe('二重に届けない', () => {
  beforeEach(async () => {
    await boot();
  });

  it('10 回叩いても受取は 1 回だけ', async () => {
    claims.registerWallet();
    for (let i = 0; i < 10; i += 1) {
      await sweep().expect(200);
    }
    expect(claims.claimCount).toBe(1);
    expect(claims.enqueued).toHaveLength(1);
  });

  it('2 回目以降は何も拾わない', async () => {
    claims.registerWallet();
    await sweep().expect(200);
    const second = await sweep().expect(200);
    expect(second.body.pickedCount).toBe(0);
  });
});

describe('自動で動かさないもの', () => {
  it('取り消し済みは届けない（人の判断へ回す）', async () => {
    await boot({
      repo: new FakeClaims({ status: 'revoked', purchaserCommonUserId: PURCHASER_CU }),
    });
    const response = await sweep().expect(200);
    // 拾う条件（`issued`）から外れているので、そもそも拾われない。
    expect(response.body).toMatchObject({ pickedCount: 0, deliveredCount: 0 });
  });

  it('期限切れは届けない', async () => {
    await boot({
      repo: new FakeClaims({
        purchaserCommonUserId: PURCHASER_CU,
        expiresAt: new Date(TEST_NOW.getTime() - 1),
      }),
    });
    const response = await sweep().expect(200);
    expect(response.body).toMatchObject({ deliveredCount: 0, skippedCount: 1 });
  });
});

describe('Wallet へ繋いでいない配備', () => {
  beforeEach(async () => {
    await boot({ deliveryEnabled: false });
  });

  it('口は生えていて、0 件を返す', async () => {
    /*
      ⚠️ **口ごと消さない。** 消すと時計の設定を配備ごとに変えることになり、
         繋いだ日に設定漏れで動かない。
    */
    claims.registerWallet();
    const response = await sweep().expect(200);
    expect(response.body).toEqual({
      pickedCount: 0,
      deliveredCount: 0,
      skippedCount: 0,
      failedCount: 0,
    });
  });

  it('受取権を勝手に確定させない', async () => {
    claims.registerWallet();
    await sweep().expect(200);
    // ⚠️ 送れないのに受取済みにすると、繋いだあとに誰も届けなくなる。
    expect(claims.status).toBe('issued');
  });
});
