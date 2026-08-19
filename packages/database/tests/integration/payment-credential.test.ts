import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import type { SealedSecret, SecretCipherPort, SecretScope } from '@sengoku/domain';
import type { PrismaClient } from '../../generated/client';
import { PrismaPaymentCredentialRepository } from '../../src/repositories/payment-credential.repository';
import {
  createTestClient,
  integrationTestsAvailable,
  resetDatabase,
  violatesConstraint,
} from '../helpers/database';

/**
 * 決済資格情報の世代（`UD-118`）を実 PostgreSQL に対して確かめる。
 *
 * ⚠️ **ここを Fake で済ませない。** 確かめたいのは「新規受付の世代が
 * 常に 1 つ」「接続確認を通らずに有効化できない」で、どちらも
 * 部分UNIQUE と CHECK が保証している。Fake は制約を持たないので、
 * 制約を外しても試験が通ってしまう。
 */
const enabled = integrationTestsAvailable();
const suite = enabled ? describe : describe.skip;

let prisma: PrismaClient;
let repo: PrismaPaymentCredentialRepository;
let accountId: string;

const NOW = new Date('2026-08-19T12:00:00.000Z');
const LIVE_KEY = 'sk_live_examplekey0123456789';
const WEBHOOK_KEY = 'whsec_examplesecret0123456789';

class TestCipher implements SecretCipherPort {
  constructor(private readonly key: Buffer) {}

  seal(plaintext: string, scope: SecretScope): SealedSecret {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(`${scope.service}:${scope.environment}`, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      ciphertext: ciphertext.toString('base64'),
      nonce: nonce.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      keyVersion: 'v1',
      // ⚠️ 決済では末尾 4 文字を持たない（2026-08-19 決定）。
      lastFour: '',
    };
  }

  open(sealed: SealedSecret, scope: SecretScope): string | null {
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.key,
        Buffer.from(sealed.nonce, 'base64'),
      );
      decipher.setAAD(Buffer.from(`${scope.service}:${scope.environment}`, 'utf8'));
      decipher.setAuthTag(Buffer.from(sealed.authTag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      return null;
    }
  }
}

const cipher = new TestCipher(randomBytes(32));
const scope = { service: 'payment' as const, environment: 'production' as const };

async function seedAccount(): Promise<string> {
  const id = randomUUID();
  await prisma.account.create({
    data: { id, authProvider: 'dev', authSubject: `cred-${id}`, role: 'operator' },
  });
  return id;
}

async function register(label: string): Promise<string> {
  const row = await repo.register({
    provider: 'stripe',
    environment: 'production',
    label,
    apiVersion: null,
    secretKey: cipher.seal(LIVE_KEY, scope),
    webhookSecret: cipher.seal(WEBHOOK_KEY, scope),
    registeredByAccountId: accountId,
  });
  return row.id;
}

async function registerAndCheck(label: string, accountRef: string): Promise<string> {
  const id = await register(label);
  await repo.recordCheck({ id, succeeded: true, accountRef, checkedAt: NOW });
  return id;
}

beforeAll(() => {
  if (!enabled) {
    return;
  }
  prisma = createTestClient();
  repo = new PrismaPaymentCredentialRepository(prisma, cipher);
});

afterAll(async () => {
  if (enabled) {
    await prisma.$disconnect();
  }
});

beforeEach(async () => {
  if (!enabled) {
    return;
  }
  await resetDatabase(prisma);
  accountId = await seedAccount();
});

suite('世代の登録と有効化', () => {
  it('登録した時点では何も起きない（戻せる状態を経由する）', async () => {
    const id = await register('初代');
    const row = await repo.findById(id);
    expect(row?.status).toBe('pending');
    expect(row?.acceptsNewPayments).toBe(false);
    expect(row?.generation).toBe(1);
  });

  it('世代番号は 1 から増える', async () => {
    await register('初代');
    const second = await register('二代目');
    expect((await repo.findById(second))?.generation).toBe(2);
  });

  /*
    ⚠️ **接続確認を通らずに有効化できない。** 二者承認をやめた
       （2026-08-19 決定）代わりの守り。鍵の打ち間違いをここで止める。
  */
  it('接続確認を通っていない世代は有効化できない', async () => {
    const id = await register('初代');
    await expect(
      repo.activate({
        id,
        steppedDownId: null,
        activatedByAccountId: accountId,
        activatedAt: NOW,
      }),
    ).rejects.toThrow();
  });

  it('接続確認に失敗した世代も有効化できない', async () => {
    const id = await register('初代');
    await repo.recordCheck({ id, succeeded: false, accountRef: null, checkedAt: NOW });
    await expect(
      repo.activate({
        id,
        steppedDownId: null,
        activatedByAccountId: accountId,
        activatedAt: NOW,
      }),
    ).rejects.toThrow();
  });

  it('接続確認を通れば有効化できる', async () => {
    const id = await registerAndCheck('初代', 'acct_first');
    const activated = await repo.activate({
      id,
      steppedDownId: null,
      activatedByAccountId: accountId,
      activatedAt: NOW,
    });
    expect(activated?.status).toBe('active');
    expect(activated?.acceptsNewPayments).toBe(true);
    expect(activated?.accountRef).toBe('acct_first');
  });
});

suite('新規受付の世代は常に 1 つ', () => {
  /*
    ⚠️ **2 つあると入金先が不定になる。** どちらの事業者へ入るかが
       運まかせになり、しかも画面からは気づけない。
  */
  it('受付世代を 2 つ作れない（部分UNIQUE）', async () => {
    const first = await registerAndCheck('初代', 'acct_first');
    await repo.activate({
      id: first,
      steppedDownId: null,
      activatedByAccountId: accountId,
      activatedAt: NOW,
    });

    const second = await registerAndCheck('二代目', 'acct_second');
    // 旧世代を降ろさずに立てようとする。
    await expect(
      repo.activate({
        id: second,
        steppedDownId: null,
        activatedByAccountId: accountId,
        activatedAt: NOW,
      }),
    ).rejects.toThrow();

    // 受付はまだ初代のまま。
    const rows = await repo.list('stripe', 'production');
    expect(rows.filter((row) => row.acceptsNewPayments)).toHaveLength(1);
    expect(rows.find((row) => row.acceptsNewPayments)?.generation).toBe(1);
  });

  it('旧世代を降ろしながらなら切り替えられる', async () => {
    const first = await registerAndCheck('初代', 'acct_first');
    await repo.activate({
      id: first,
      steppedDownId: null,
      activatedByAccountId: accountId,
      activatedAt: NOW,
    });
    const second = await registerAndCheck('二代目', 'acct_second');

    const activated = await repo.activate({
      id: second,
      steppedDownId: first,
      activatedByAccountId: accountId,
      activatedAt: NOW,
    });
    expect(activated?.generation).toBe(2);

    const rows = await repo.list('stripe', 'production');
    const old = rows.find((row) => row.generation === 1);
    /*
      ⚠️ **旧世代は `retired` にしない。** 返金と照会は旧世代の鍵で続く。
         ここで退役させると、切り替えた瞬間に過去の注文が返金不能になる。
    */
    expect(old?.status).toBe('active');
    expect(old?.acceptsNewPayments).toBe(false);
    expect(old?.retiredAt).toBeNull();
  });
});

suite('退役と削除', () => {
  it('受付中の世代は退役させられない', async () => {
    const id = await registerAndCheck('初代', 'acct_first');
    await repo.activate({
      id,
      steppedDownId: null,
      activatedByAccountId: accountId,
      activatedAt: NOW,
    });
    expect(await repo.retire(id, NOW)).toBeNull();
  });

  /*
    ⚠️ **世代を消せない。** 消すと、その世代で処理した決済の返金経路が
       消える。`payments.credential_id` の ON DELETE RESTRICT が守る。
  */
  it('決済が指している世代は削除できない', async () => {
    const id = await registerAndCheck('初代', 'acct_first');
    await repo.activate({
      id,
      steppedDownId: null,
      activatedByAccountId: accountId,
      activatedAt: NOW,
    });

    const creator = await seedAccount();
    const artwork = await prisma.artwork.create({
      data: {
        creatorAccountId: creator,
        slug: `cred-${randomUUID()}`,
        title: '作品',
        maxSupply: 1,
        status: 'published',
      },
    });
    const order = await prisma.order.create({
      data: {
        orderNumber: `SNK-20260819-${randomUUID().slice(0, 8).toUpperCase()}`,
        accountId,
        creatorAccountId: creator,
        subtotalAmount: 1000,
        totalAmount: 1000,
        totalCurrency: 'JPY',
        creatorAmount: 800,
        platformFeeRateBps: 2000,
        platformFeeAmount: 200,
        idempotencyKey: randomUUID(),
      },
    });
    await prisma.payment.create({
      data: {
        orderId: order.id,
        provider: 'stripe',
        amount: 1000,
        currency: 'JPY',
        credentialId: id,
      },
    });
    void artwork;

    await expect(prisma.paymentCredential.delete({ where: { id } })).rejects.toThrow();
  });
});

suite('DB の縛り', () => {
  it('接続確認なしの active を直接入れられない', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "payment_credentials"
           ("provider", "environment", "generation", "status",
            "secret_key_ciphertext", "secret_key_nonce", "secret_key_auth_tag",
            "webhook_secret_ciphertext", "webhook_secret_nonce", "webhook_secret_auth_tag",
            "key_version", "activated_by_account_id", "registered_by_account_id", "updated_at")
         VALUES ('stripe', 'production', 9, 'active', 'x','x','x','x','x','x','v1',
                 $1::uuid, $1::uuid, CURRENT_TIMESTAMP)`,
        accountId,
      ),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'payment_credentials_active_requires_check'),
    );
  });

  it('pending が新規受付になれない', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "payment_credentials"
           ("provider", "environment", "generation", "status", "accepts_new_payments",
            "secret_key_ciphertext", "secret_key_nonce", "secret_key_auth_tag",
            "webhook_secret_ciphertext", "webhook_secret_nonce", "webhook_secret_auth_tag",
            "key_version", "registered_by_account_id", "updated_at")
         VALUES ('stripe', 'production', 9, 'pending', true, 'x','x','x','x','x','x','v1',
                 $1::uuid, CURRENT_TIMESTAMP)`,
        accountId,
      ),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'payment_credentials_accepts_only_when_active'),
    );
  });

  it('同じ世代番号を 2 つ作れない', async () => {
    await register('初代');
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "payment_credentials"
           ("provider", "environment", "generation", "status",
            "secret_key_ciphertext", "secret_key_nonce", "secret_key_auth_tag",
            "webhook_secret_ciphertext", "webhook_secret_nonce", "webhook_secret_auth_tag",
            "key_version", "registered_by_account_id", "updated_at")
         VALUES ('stripe', 'production', 1, 'pending', 'x','x','x','x','x','x','v1',
                 $1::uuid, CURRENT_TIMESTAMP)`,
        accountId,
      ),
    ).rejects.toThrow();
  });
});

suite('鍵の取り扱い', () => {
  it('一覧は鍵を持たない', async () => {
    const id = await registerAndCheck('初代', 'acct_first');
    const rows = await repo.list('stripe', 'production');
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(LIVE_KEY);
    expect(serialized).not.toContain(WEBHOOK_KEY);
    // ⚠️ 末尾 4 文字も出さない（2026-08-19 決定）。
    expect(serialized).not.toContain(LIVE_KEY.slice(-4));
    void id;
  });

  it('検証用には新しい順で鍵つきに開ける', async () => {
    const first = await registerAndCheck('初代', 'acct_first');
    await repo.activate({
      id: first,
      steppedDownId: null,
      activatedByAccountId: accountId,
      activatedAt: NOW,
    });
    const second = await registerAndCheck('二代目', 'acct_second');
    await repo.activate({
      id: second,
      steppedDownId: first,
      activatedByAccountId: accountId,
      activatedAt: NOW,
    });

    const opened = await repo.openForVerification('stripe', 'production', 5);
    expect(opened.map((row) => row.generation)).toEqual([2, 1]);
    expect(opened[0]?.webhookSecret).toBe(WEBHOOK_KEY);
  });

  /*
    ⚠️ **退役した世代も検証対象に残る。** 切り替え後も旧アカウントの
       知らせは届く。外すと旧世代の決済が捨てられる。
  */
  it('退役した世代も検証対象に残る', async () => {
    const first = await registerAndCheck('初代', 'acct_first');
    await repo.activate({
      id: first,
      steppedDownId: null,
      activatedByAccountId: accountId,
      activatedAt: NOW,
    });
    const second = await registerAndCheck('二代目', 'acct_second');
    await repo.activate({
      id: second,
      steppedDownId: first,
      activatedByAccountId: accountId,
      activatedAt: NOW,
    });
    await repo.retire(first, NOW);

    const opened = await repo.openForVerification('stripe', 'production', 5);
    expect(opened.map((row) => row.generation)).toEqual([2, 1]);
  });

  it('上限を超えた古い世代は検証対象から外れる', async () => {
    for (let i = 0; i < 4; i += 1) {
      await registerAndCheck(`世代${String(i)}`, `acct_${String(i)}`);
    }
    const opened = await repo.openForVerification('stripe', 'production', 2);
    expect(opened.map((row) => row.generation)).toEqual([4, 3]);
  });
});
