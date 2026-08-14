import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../../generated/client';
import { PrismaCommonUserLinkRepository } from '../../src/repositories/common-user-link.repository';
import {
  createTestClient,
  integrationTestsAvailable,
  resetDatabase,
  violatesConstraint,
} from '../helpers/database';

/**
 * 共通顧客ID の列と制約を、実 PostgreSQL に対して確かめる。
 *
 * ⚠️ アプリ側の判断に穴があっても、壊れた行が保存されないことを見る。
 */
const enabled = integrationTestsAvailable();
const suite = enabled ? describe : describe.skip;

let prisma: PrismaClient;
let repo: PrismaCommonUserLinkRepository;

const NOW = new Date('2026-06-01T00:00:00.000Z');
const CU_A = 'cu_' + 'a'.repeat(32);
const CU_B = 'cu_' + 'b'.repeat(32);

beforeAll(async () => {
  if (!enabled) return;
  prisma = createTestClient();
  await prisma.$connect();
  repo = new PrismaCommonUserLinkRepository(prisma);
});

afterAll(async () => {
  if (!enabled) return;
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!enabled) return;
  await resetDatabase(prisma);
});

async function seedAccount(overrides: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await prisma.account.create({
    data: {
      id,
      authProvider: 'dev',
      authSubject: `subject-${id.slice(0, 8)}`,
      ...overrides,
    },
  });
  return id;
}

suite('共通顧客ID の CHECK 制約', () => {
  it('未知の状態は入らない', async () => {
    await expect(seedAccount({ commonUserStatus: 'WHATEVER' })).rejects.toSatisfy((error) =>
      violatesConstraint(error, 'accounts_common_user_status_known'),
    );
  });

  it('契約と違う形式の common_user_id は入らない', async () => {
    // 取り違えた値（自社の account id など）をそのまま保存させない。
    await expect(
      seedAccount({
        commonUserId: '00000000-0000-4000-8000-000000000001',
        commonUserStatus: 'RESOLVED',
        commonUserLinkedAt: NOW,
      }),
    ).rejects.toSatisfy((error) => violatesConstraint(error, 'accounts_common_user_id_format'));
  });

  it('大文字の hex も拒否する（契約は小文字）', async () => {
    await expect(
      seedAccount({
        commonUserId: `cu_${'A'.repeat(32)}`,
        commonUserStatus: 'RESOLVED',
        commonUserLinkedAt: NOW,
      }),
    ).rejects.toSatisfy((error) => violatesConstraint(error, 'accounts_common_user_id_format'));
  });

  it('RESOLVED なのに値が無い行は入らない', async () => {
    // 「解決済みなのに ID が無い」行があると、Claim の照合がそこで落ちる。
    await expect(seedAccount({ commonUserStatus: 'RESOLVED' })).rejects.toSatisfy((error) =>
      violatesConstraint(error, 'accounts_common_user_resolved_has_id'),
    );
  });

  it('RESOLVED なのに紐付け時刻が無い行は入らない', async () => {
    await expect(
      seedAccount({ commonUserStatus: 'RESOLVED', commonUserId: CU_A }),
    ).rejects.toSatisfy((error) =>
      violatesConstraint(error, 'accounts_common_user_resolved_has_id'),
    );
  });

  it('UNRESOLVED なのに失敗の痕跡が残る行は入らない', async () => {
    await expect(
      seedAccount({ commonUserStatus: 'UNRESOLVED', commonUserLastError: 'timeout' }),
    ).rejects.toSatisfy((error) =>
      violatesConstraint(error, 'accounts_common_user_unresolved_is_clean'),
    );
  });

  it('試行回数は負にならない', async () => {
    await expect(seedAccount({ commonUserAttemptCount: -1 })).rejects.toSatisfy((error) =>
      violatesConstraint(error, 'accounts_common_user_attempt_count_non_negative'),
    );
  });

  it('同じ common_user_id を複数アカウントが持てる', async () => {
    // 同一人物が別の認証手段で 2 アカウントを持つと、どちらも同じ ID へ解決される。
    // UNIQUE にすると、正しい解決結果が保存できずに落ちる。
    await seedAccount({
      commonUserId: CU_A,
      commonUserStatus: 'RESOLVED',
      commonUserLinkedAt: NOW,
    });
    await expect(
      seedAccount({ commonUserId: CU_A, commonUserStatus: 'RESOLVED', commonUserLinkedAt: NOW }),
    ).resolves.toBeDefined();
  });
});

suite('紐付けリポジトリ', () => {
  it('新規アカウントは UNRESOLVED で始まる', async () => {
    const id = await seedAccount();
    const link = await repo.findByAccountId(id);
    expect(link?.status).toBe('UNRESOLVED');
    expect(link?.commonUserId).toBeNull();
    expect(link?.attemptCount).toBe(0);
  });

  it('条件付き更新は、試行回数が一致するときだけ書く', async () => {
    // 同時に走った別の試行の結果を、古い結果で踏み潰さないための仕掛け。
    const id = await seedAccount();
    const link = await repo.findByAccountId(id);
    expect(link).not.toBeNull();
    if (link === null) return;

    const first = await repo.save(
      { ...link, status: 'RESOLVED', commonUserId: CU_A, linkedAt: NOW, attemptCount: 1 },
      0,
    );
    expect(first).toBe(true);

    // 古い期待値（0）で上書きしようとしても通らない。
    const stale = await repo.save(
      { ...link, status: 'RESOLVED', commonUserId: CU_B, linkedAt: NOW, attemptCount: 1 },
      0,
    );
    expect(stale).toBe(false);

    const after = await repo.findByAccountId(id);
    expect(after?.commonUserId).toBe(CU_A);
  });

  it('再試行の対象は PENDING / UNRESOLVED のうち時刻が来たものだけ', async () => {
    const due = await seedAccount({
      commonUserStatus: 'PENDING',
      commonUserAttemptCount: 1,
      commonUserLastError: 'timeout',
      commonUserNextAttemptAt: new Date('2026-05-01T00:00:00.000Z'),
    });
    const notYet = await seedAccount({
      commonUserStatus: 'PENDING',
      commonUserAttemptCount: 1,
      commonUserLastError: 'timeout',
      commonUserNextAttemptAt: new Date('2026-07-01T00:00:00.000Z'),
    });
    const resolved = await seedAccount({
      commonUserStatus: 'RESOLVED',
      commonUserId: CU_A,
      commonUserLinkedAt: NOW,
    });
    const conflicted = await seedAccount({
      commonUserStatus: 'CONFLICT',
      commonUserAttemptCount: 2,
      commonUserLastError: 'differs',
    });

    const ids = (await repo.listDue(NOW, 50)).map((item) => item.accountId);
    expect(ids).toContain(due);
    expect(ids).not.toContain(notYet);
    expect(ids).not.toContain(resolved);
    expect(ids).not.toContain(conflicted);
  });
});
