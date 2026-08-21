import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import type { SealedSecret, SecretCipherPort, SecretScope } from '@sengoku/domain';
import type { PrismaClient } from '../../generated/client';
import { PrismaPaymentCredentialRepository } from '../../src/repositories/payment-credential.repository';
import {
  PrismaAttestationRepository,
  PrismaProductionReadinessRepository,
} from '../../src/repositories/production.repository';
import {
  createTestClient,
  integrationTestsAvailable,
  resetDatabase,
  violatesConstraint,
} from '../helpers/database';

/**
 * 本番販売ガード（実運営 指示書 P0-7）を実 PostgreSQL に対して確かめる。
 *
 * ⚠️ ここで見たいのは 3 つ。
 *  1. **証跡を書き換えられないこと。** アプリに口を作らないだけでは、
 *     アプリを通さない書き込みを止められない
 *  2. **事実の集め方が、判定と同じ意味になっていること。**
 *     とくに「施行中」は施行日と現在時刻で決まる（公開済みとは違う）
 *  3. **証跡のある世代を消せないこと。** 消せると証跡が宙に浮く
 */
const enabled = integrationTestsAvailable();
const suite = enabled ? describe : describe.skip;

const NOW = new Date('2026-08-21T00:00:00.000Z');
const LIVE_KEY = ['sk', 'live', 'examplekey0123456789'].join('_');
const WEBHOOK_KEY = ['whsec', 'examplesecret0123456789'].join('_');

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

let prisma: PrismaClient;
let credentials: PrismaPaymentCredentialRepository;
let attestations: PrismaAttestationRepository;
let readiness: PrismaProductionReadinessRepository;
let ownerId: string;

beforeAll(() => {
  if (!enabled) return;
  prisma = createTestClient();
  credentials = new PrismaPaymentCredentialRepository(prisma, cipher);
  attestations = new PrismaAttestationRepository(prisma, 'production');
  readiness = new PrismaProductionReadinessRepository(prisma, 'production', 'stripe');
});

afterAll(async () => {
  if (enabled) await prisma.$disconnect();
});

beforeEach(async () => {
  if (!enabled) return;
  await resetDatabase(prisma);
  ownerId = randomUUID();
  await prisma.account.create({
    data: {
      id: ownerId,
      authProvider: 'dev',
      authSubject: `owner-${ownerId}`,
      role: 'operator',
      isOwner: true,
    },
  });
});

/** 受付中の世代を 1 つ作る。⚠️ 接続確認を通さないと有効化できない。 */
async function activeCredential(): Promise<string> {
  const row = await credentials.register({
    provider: 'stripe',
    environment: 'production',
    label: '初代',
    apiVersion: null,
    secretKey: cipher.seal(LIVE_KEY, scope),
    webhookSecret: cipher.seal(WEBHOOK_KEY, scope),
    registeredByAccountId: ownerId,
  });
  await credentials.recordCheck({
    id: row.id,
    succeeded: true,
    accountRef: 'acct_test',
    checkedAt: NOW,
  });
  await credentials.activate({
    id: row.id,
    steppedDownId: null,
    activatedByAccountId: ownerId,
    activatedAt: NOW,
  });
  return row.id;
}

suite('証跡は追記のみ', () => {
  it('記録できる', async () => {
    const credentialId = await activeCredential();
    const id = await attestations.record(
      {
        kind: 'e2e_sale_test',
        succeeded: true,
        credentialId,
        attestedByAccountId: ownerId,
        note: '1 件購入し、お届けまで通りました。',
      },
      NOW,
    );
    expect(id).toBeTruthy();
    const latest = await attestations.latest('e2e_sale_test');
    expect(latest?.succeeded).toBe(true);
    expect(latest?.credentialId).toBe(credentialId);
  });

  /*
    ⚠️ **これが本題。** アプリに口を作らないだけでは、アプリを通さない
       書き込みを止められない。DB の側でも止める。
  */
  it('あとから書き換えられない', async () => {
    const credentialId = await activeCredential();
    const id = await attestations.record(
      {
        kind: 'owner_approval',
        succeeded: true,
        credentialId,
        attestedByAccountId: ownerId,
        note: null,
      },
      NOW,
    );
    await expect(
      prisma.productionAttestation.update({ where: { id }, data: { succeeded: false } }),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'production_attestations_append_only'),
    );
  });

  it('消せない', async () => {
    const credentialId = await activeCredential();
    const id = await attestations.record(
      {
        kind: 'owner_approval',
        succeeded: true,
        credentialId,
        attestedByAccountId: ownerId,
        note: null,
      },
      NOW,
    );
    await expect(prisma.productionAttestation.delete({ where: { id } })).rejects.toSatisfy(
      (error: unknown) => violatesConstraint(error, 'production_attestations_append_only'),
    );
  });

  /*
    ⚠️ **訂正は新しい記録を足して表す。** 消せないので、これが唯一の道。
  */
  it('訂正は新しい記録で表す（直近が正）', async () => {
    const credentialId = await activeCredential();
    await attestations.record(
      {
        kind: 'e2e_sale_test',
        succeeded: false,
        credentialId,
        attestedByAccountId: ownerId,
        note: '配送の巡回で止まりました。',
      },
      NOW,
    );
    await attestations.record(
      {
        kind: 'e2e_sale_test',
        succeeded: true,
        credentialId,
        attestedByAccountId: ownerId,
        note: '直したうえで通しました。',
      },
      new Date(NOW.getTime() + 60_000),
    );

    expect((await attestations.latest('e2e_sale_test'))?.succeeded).toBe(true);
    // ⚠️ 失敗した記録も残っている。都合の悪い記録が消えない。
    expect(await attestations.list(10)).toHaveLength(2);
  });

  it('理由の無い「不成立」は DB が拒む', async () => {
    const credentialId = await activeCredential();
    await expect(
      prisma.productionAttestation.create({
        data: {
          kind: 'e2e_sale_test',
          environment: 'production',
          succeeded: false,
          credentialId,
          attestedByAccountId: ownerId,
          note: null,
          attestedAt: NOW,
        },
      }),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'production_attestations_failure_has_note'),
    );
  });

  it('知らない種別は DB が拒む', async () => {
    const credentialId = await activeCredential();
    await expect(
      prisma.productionAttestation.create({
        data: {
          kind: 'looks_fine_to_me',
          environment: 'production',
          succeeded: true,
          credentialId,
          attestedByAccountId: ownerId,
          attestedAt: NOW,
        },
      }),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'production_attestations_kind_known'),
    );
  });

  /*
    ⚠️ **環境をまたいで証拠を使い回させない。** staging で通した試験は、
       本番の証拠にならない。
  */
  it('staging の記録は production から見えない', async () => {
    const credentialId = await activeCredential();
    const staging = new PrismaAttestationRepository(prisma, 'staging');
    await staging.record(
      {
        kind: 'owner_approval',
        succeeded: true,
        credentialId,
        attestedByAccountId: ownerId,
        note: null,
      },
      NOW,
    );
    expect(await attestations.latest('owner_approval')).toBeNull();
    expect(await staging.latest('owner_approval')).not.toBeNull();
  });

  /*
    ⚠️ **証跡のある世代を消せない。** 消せると、証跡が何の証拠でも
       なくなる（`ON DELETE RESTRICT`）。
  */
  it('証跡のある決済世代は消せない', async () => {
    const credentialId = await activeCredential();
    await attestations.record(
      {
        kind: 'owner_approval',
        succeeded: true,
        credentialId,
        attestedByAccountId: ownerId,
        note: null,
      },
      NOW,
    );
    await expect(
      prisma.paymentCredential.delete({ where: { id: credentialId } }),
    ).rejects.toThrow();
  });
});

suite('事実の集め方', () => {
  it('何も無ければ、すべて「無い」で返る', async () => {
    const facts = await readiness.facts(NOW);
    expect(facts.acceptingCredential).toBeNull();
    expect(facts.platformFeeRateBps).toBe(0);
    expect(facts.publishedLegalKinds).toEqual([]);
    expect(facts.walletCheck).toBeNull();
    expect(facts.mailCheck).toBeNull();
    expect(facts.latestE2eSaleTest).toBeNull();
  });

  it('受付中の世代を拾う', async () => {
    const credentialId = await activeCredential();
    const facts = await readiness.facts(NOW);
    expect(facts.acceptingCredential?.id).toBe(credentialId);
    expect(facts.acceptingCredential?.lastCheckSucceeded).toBe(true);
  });

  /*
    ⚠️ **「公開した」ではなく「施行日を迎えた」。** 予約公開があるので、
       両者は一致しない。未来の施行日を数えると、まだ掲げていないものを
       掲げたことにしてしまう。
  */
  it('施行日がまだ来ていない版は数えない', async () => {
    await prisma.legalDocumentVersion.create({
      data: {
        kind: 'terms',
        version: 1,
        status: 'published',
        title: '利用規約',
        bodyText: '本文',
        effectiveFrom: new Date('2026-12-01T00:00:00.000Z'),
        publishedAt: NOW,
        createdByAccountId: ownerId,
        publishedByAccountId: ownerId,
      },
    });
    expect((await readiness.facts(NOW)).publishedLegalKinds).toEqual([]);
  });

  it('施行日を迎えた版は数える', async () => {
    await prisma.legalDocumentVersion.create({
      data: {
        kind: 'terms',
        version: 1,
        status: 'published',
        title: '利用規約',
        bodyText: '本文',
        effectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
        publishedAt: NOW,
        createdByAccountId: ownerId,
        publishedByAccountId: ownerId,
      },
    });
    expect((await readiness.facts(NOW)).publishedLegalKinds).toEqual(['terms']);
  });

  /*
    ⚠️ **成功だけを拾わない。** 直近が失敗しているなら、それが現状。
       成功だけを拾うと、いま壊れているのに「前に成功した」で通る。
  */
  it('接続確認は直近 1 件を見る（成功だけを拾わない）', async () => {
    await prisma.integrationConnectionCheck.createMany({
      data: [
        {
          service: 'ovew_wallet',
          environment: 'production',
          kind: 'reachability',
          succeeded: true,
          durationMs: 10,
          executedAt: new Date('2026-08-20T00:00:00.000Z'),
        },
        {
          service: 'ovew_wallet',
          environment: 'production',
          kind: 'reachability',
          succeeded: false,
          durationMs: 10,
          executedAt: new Date('2026-08-20T12:00:00.000Z'),
        },
      ],
    });
    expect((await readiness.facts(NOW)).walletCheck?.succeeded).toBe(false);
  });

  /*
    ⚠️ **停止した人の記録で条件を満たせない。** 満たせると、責任を
       引き受ける人が居ないまま通ってしまう。
  */
  it('停止中のオーナーは数えない', async () => {
    await prisma.account.update({ where: { id: ownerId }, data: { status: 'suspended' } });
    expect((await readiness.facts(NOW)).owners).toEqual([]);
  });

  it('二要素で入った記録を拾う', async () => {
    const at = new Date('2026-08-15T00:00:00.000Z');
    await prisma.account.update({ where: { id: ownerId }, data: { lastAal2At: at } });
    const facts = await readiness.facts(NOW);
    expect(facts.owners).toHaveLength(1);
    expect(facts.owners[0]?.lastAal2At?.toISOString()).toBe(at.toISOString());
  });
});
