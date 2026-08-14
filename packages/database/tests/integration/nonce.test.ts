import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../../generated/client';
import { PrismaNonceStore } from '../../src/repositories/nonce.repository';
import {
  createTestClient,
  integrationTestsAvailable,
  resetDatabase,
  violatesConstraint,
} from '../helpers/database';

/**
 * nonce の記録を実 PostgreSQL に対して確かめる。
 *
 * ⚠️ **ここを Fake で済ませない。**
 * 確かめたいのは「同時に届いた同じ nonce のうち 1 本しか通らない」ことで、
 * それを保証しているのは一意制約そのもの。メモリ実装で確かめても意味がない。
 */
const enabled = integrationTestsAvailable();
const suite = enabled ? describe : describe.skip;

let prisma: PrismaClient;
let store: PrismaNonceStore;

const NOW = new Date('2026-06-01T00:00:00.000Z');
const EXPIRES = new Date('2026-06-01T00:05:00.000Z');

beforeAll(async () => {
  if (!enabled) return;
  prisma = createTestClient();
  await prisma.$connect();
  store = new PrismaNonceStore(prisma);
});

afterAll(async () => {
  if (!enabled) return;
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!enabled) return;
  await resetDatabase(prisma);
});

suite('nonce の記録（リプレイ拒否）', () => {
  it('初めての nonce は受け付ける', async () => {
    const fresh = await store.remember({
      keyId: 'key-1',
      nonce: randomUUID(),
      expiresAt: EXPIRES,
      now: NOW,
    });
    expect(fresh).toBe(true);
  });

  it('同じ nonce の 2 回目は拒否する', async () => {
    const nonce = randomUUID();
    await store.remember({ keyId: 'key-1', nonce, expiresAt: EXPIRES, now: NOW });

    const second = await store.remember({ keyId: 'key-1', nonce, expiresAt: EXPIRES, now: NOW });
    expect(second).toBe(false);
  });

  it('同じ nonce を同時に取り合うと、通るのは 1 本だけ', async () => {
    // 「探して無ければ受け付ける」だと、ここで複数本が通ってしまう。
    const nonce = randomUUID();
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () =>
        store.remember({ keyId: 'key-1', nonce, expiresAt: EXPIRES, now: NOW }),
      ),
    );

    expect(attempts.filter(Boolean)).toHaveLength(1);
    expect(await prisma.hmacNonce.count({ where: { keyId: 'key-1', nonce } })).toBe(1);
  });

  it('鍵IDが違えば同じ nonce を使える', async () => {
    const nonce = randomUUID();
    expect(await store.remember({ keyId: 'key-a', nonce, expiresAt: EXPIRES, now: NOW })).toBe(
      true,
    );
    expect(await store.remember({ keyId: 'key-b', nonce, expiresAt: EXPIRES, now: NOW })).toBe(
      true,
    );
  });

  it('期限を過ぎた記録は未使用として扱う', async () => {
    // 許容時間を過ぎた要求はタイムスタンプ検証で弾かれるので、
    // ここで消してもリプレイの穴にはならない。
    const nonce = randomUUID();
    await store.remember({ keyId: 'key-1', nonce, expiresAt: EXPIRES, now: NOW });

    const later = new Date('2026-06-01T00:10:00.000Z');
    const reused = await store.remember({
      keyId: 'key-1',
      nonce,
      expiresAt: new Date('2026-06-01T00:15:00.000Z'),
      now: later,
    });
    expect(reused).toBe(true);
  });

  it('期限が作成時より前の記録は入らない', async () => {
    // 記録した瞬間に「期限切れ＝未使用」と見なされ、リプレイを素通しする。
    await expect(
      prisma.hmacNonce.create({
        data: {
          keyId: 'key-1',
          nonce: randomUUID(),
          createdAt: NOW,
          expiresAt: new Date('2026-05-01T00:00:00.000Z'),
        },
      }),
    ).rejects.toSatisfy((error) => violatesConstraint(error, 'hmac_nonces_expires_after_creation'));
  });
});
