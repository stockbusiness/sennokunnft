import type { CommonUserLink, CommonUserLinkRepository, CommonUserStatus } from '@sengoku/domain';
import type { PrismaClient } from '../../generated/client';

interface LinkRow {
  readonly id: string;
  readonly commonUserId: string | null;
  readonly commonUserStatus: string;
  readonly commonUserLinkedAt: Date | null;
  readonly commonUserLastError: string | null;
  readonly commonUserAttemptCount: number;
  readonly commonUserNextAttemptAt: Date | null;
}

function toLink(row: LinkRow): CommonUserLink {
  return {
    accountId: row.id,
    commonUserId: row.commonUserId,
    // DB の CHECK 制約で 5 値に閉じている。
    status: row.commonUserStatus as CommonUserStatus,
    linkedAt: row.commonUserLinkedAt,
    lastError: row.commonUserLastError,
    attemptCount: row.commonUserAttemptCount,
    nextAttemptAt: row.commonUserNextAttemptAt,
  };
}

/**
 * 紐付け状態の Prisma 実装。
 *
 * 状態は `accounts` の列として持つ。別テーブルにしないのは、
 * アカウントと 1 対 1 で、独立したライフサイクルを持たないため。
 */
export class PrismaCommonUserLinkRepository implements CommonUserLinkRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findByAccountId(accountId: string): Promise<CommonUserLink | null> {
    const row = await this.prisma.account.findUnique({ where: { id: accountId } });
    return row === null ? null : toLink(row);
  }

  async listDue(now: Date, limit: number): Promise<readonly CommonUserLink[]> {
    const rows = await this.prisma.account.findMany({
      where: {
        commonUserStatus: { in: ['UNRESOLVED', 'PENDING'] },
        OR: [{ commonUserNextAttemptAt: null }, { commonUserNextAttemptAt: { lte: now } }],
      },
      // 古いものから順に片付ける。新しい行に押しのけられて
      // 特定の行がいつまでも処理されない状態を作らない。
      orderBy: [{ commonUserNextAttemptAt: 'asc' }, { createdAt: 'asc' }],
      take: limit,
    });
    return rows.map(toLink);
  }

  /**
   * 条件付き UPDATE。
   *
   * ⚠️ `where` に `commonUserAttemptCount` を含めるのが要点。
   * 同時に走った別の試行が既に書き込んでいれば、
   * ここの `updateMany` は 0 件になり、古い結果で上書きしない。
   */
  async save(link: CommonUserLink, expectedAttemptCount: number): Promise<boolean> {
    const result = await this.prisma.account.updateMany({
      where: { id: link.accountId, commonUserAttemptCount: expectedAttemptCount },
      data: {
        commonUserId: link.commonUserId,
        commonUserStatus: link.status,
        commonUserLinkedAt: link.linkedAt,
        commonUserLastError: link.lastError,
        commonUserAttemptCount: link.attemptCount,
        commonUserNextAttemptAt: link.nextAttemptAt,
      },
    });
    return result.count === 1;
  }
}
