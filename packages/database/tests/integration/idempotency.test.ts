import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../../generated/client';
import { PrismaIdempotencyStore } from '../../src/repositories/idempotency.repository';
import {
  createTestClient,
  integrationTestsAvailable,
  resetDatabase,
  violatesConstraint,
} from '../helpers/database';

/**
 * 冪等キーの占有を、実 PostgreSQL に対して確かめる。
 *
 * ⚠️ **ここを Fake で済ませない。**
 * 検証したいのは「同時に来た 2 本のうち 1 本しか占有できない」ことで、
 * それを保証しているのは DB の一意制約そのもの。
 * メモリ実装で確かめても、確かめたことにならない。
 */
const enabled = integrationTestsAvailable();
const suite = enabled ? describe : describe.skip;

let prisma: PrismaClient;
let store: PrismaIdempotencyStore;
let actorId: string;

const NOW = new Date('2026-06-01T00:00:00.000Z');
const EXPIRES = new Date('2026-06-02T00:00:00.000Z');

beforeAll(async () => {
  if (!enabled) return;
  prisma = createTestClient();
  await prisma.$connect();
  store = new PrismaIdempotencyStore(prisma);
});

afterAll(async () => {
  if (!enabled) return;
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!enabled) return;
  await resetDatabase(prisma);
  actorId = randomUUID();
  await prisma.account.create({
    data: { id: actorId, authProvider: 'dev', authSubject: `subject-${actorId.slice(0, 8)}` },
  });
});

function claimInput(key: string, digest = 'digest-a') {
  return { actorAccountId: actorId, key, requestDigest: digest, now: NOW, expiresAt: EXPIRES };
}

suite('冪等キーの占有（同時に来ても 1 本だけ）', () => {
  it('同じキーを同時に取り合うと、占有できるのは 1 本だけ', async () => {
    // 「探して無ければ書く」だと、ここで両方が占有できてしまう。
    const key = `key-${randomUUID()}`;
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () => store.claim(claimInput(key))),
    );

    expect(attempts.filter((result) => result.claimed)).toHaveLength(1);

    const rows = await prisma.idempotencyKey.count({ where: { actorAccountId: actorId, key } });
    expect(rows).toBe(1);
  });

  it('占有できなかった側には既存の状態が返る', async () => {
    const key = `key-${randomUUID()}`;
    await store.claim(claimInput(key));

    const second = await store.claim(claimInput(key));
    expect(second.claimed).toBe(false);
    expect(second.existing?.state).toBe('in_progress');
    expect(second.existing?.requestDigest).toBe('digest-a');
  });

  it('完了を記録すると、次の呼び出しに応答が返る', async () => {
    const key = `key-${randomUUID()}`;
    await store.claim(claimInput(key));
    await store.complete({
      actorAccountId: actorId,
      key,
      statusCode: 201,
      responseBody: { id: 'artwork-1' },
    });

    const second = await store.claim(claimInput(key));
    expect(second.claimed).toBe(false);
    expect(second.existing?.state).toBe('completed');
    expect(second.existing?.statusCode).toBe(201);
    expect(second.existing?.responseBody).toEqual({ id: 'artwork-1' });
  });

  it('解放すると、同じキーをもう一度占有できる', async () => {
    const key = `key-${randomUUID()}`;
    await store.claim(claimInput(key));
    await store.release(actorId, key);

    const retry = await store.claim(claimInput(key));
    expect(retry.claimed).toBe(true);
  });

  it('完了済みのキーは解放しても消えない', async () => {
    const key = `key-${randomUUID()}`;
    await store.claim(claimInput(key));
    await store.complete({ actorAccountId: actorId, key, statusCode: 200, responseBody: null });
    await store.release(actorId, key);

    const second = await store.claim(claimInput(key));
    expect(second.claimed).toBe(false);
    expect(second.existing?.state).toBe('completed');
  });

  it('期限切れのキーは未使用として扱う', async () => {
    const key = `key-${randomUUID()}`;
    await store.claim(claimInput(key));

    const later = {
      ...claimInput(key),
      now: new Date('2026-06-03T00:00:00.000Z'),
      expiresAt: new Date('2026-06-04T00:00:00.000Z'),
    };
    const retry = await store.claim(later);
    expect(retry.claimed).toBe(true);
  });

  it('アクターが違えば同じキーでも占有できる', async () => {
    // 区切らないと、他人のキーを当てて応答を読み出せてしまう。
    const key = `key-${randomUUID()}`;
    await store.claim(claimInput(key));

    const otherId = randomUUID();
    await prisma.account.create({
      data: { id: otherId, authProvider: 'dev', authSubject: `other-${otherId.slice(0, 8)}` },
    });

    const other = await store.claim({
      actorAccountId: otherId,
      key,
      requestDigest: 'digest-a',
      now: NOW,
      expiresAt: EXPIRES,
    });
    expect(other.claimed).toBe(true);
  });
});

suite('冪等キーの CHECK 制約', () => {
  it('未知の状態は入らない', async () => {
    await expect(
      prisma.idempotencyKey.create({
        data: {
          actorAccountId: actorId,
          key: `key-${randomUUID()}`,
          requestDigest: 'digest-a',
          status: 'whatever',
          createdAt: NOW,
          expiresAt: EXPIRES,
        },
      }),
    ).rejects.toSatisfy((error) => violatesConstraint(error, 'idempotency_keys_status_known'));
  });

  it('completed なのに応答が欠けた行は入らない', async () => {
    // 揃っていない completed を返すと、2 回目の呼び出しが壊れた応答を受け取る。
    await expect(
      prisma.idempotencyKey.create({
        data: {
          actorAccountId: actorId,
          key: `key-${randomUUID()}`,
          requestDigest: 'digest-a',
          status: 'completed',
          createdAt: NOW,
          expiresAt: EXPIRES,
        },
      }),
    ).rejects.toSatisfy((error) =>
      violatesConstraint(error, 'idempotency_keys_completed_has_response'),
    );
  });

  it('in_progress なのに応答が入った行は入らない', async () => {
    await expect(
      prisma.idempotencyKey.create({
        data: {
          actorAccountId: actorId,
          key: `key-${randomUUID()}`,
          requestDigest: 'digest-a',
          status: 'in_progress',
          statusCode: 200,
          completedAt: NOW,
          createdAt: NOW,
          expiresAt: EXPIRES,
        },
      }),
    ).rejects.toSatisfy((error) =>
      violatesConstraint(error, 'idempotency_keys_completed_has_response'),
    );
  });
});
