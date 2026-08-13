import type {
  IdempotencyClaimInput,
  IdempotencyClaimResult,
  IdempotencyRecord,
  IdempotencyState,
  IdempotencyStore,
} from '@sengoku/domain';
import type { PrismaClient } from '../../generated/client';

/**
 * 冪等キーの Prisma 実装。
 *
 * ⚠️ **一意制約が判定そのもの。**
 * 「SELECT して無ければ INSERT」ではなく、いきなり INSERT を試みて、
 * 一意制約に弾かれたかどうかで占有の成否を決める。
 * SELECT と INSERT のあいだには必ず隙間があり、
 * 同時に来た 2 本がそこをすり抜ける。
 */
export class PrismaIdempotencyStore implements IdempotencyStore {
  constructor(private readonly prisma: PrismaClient) {}

  async claim(input: IdempotencyClaimInput): Promise<IdempotencyClaimResult> {
    return this.prisma.$transaction(async (tx) => {
      // 期限切れの行は未使用として扱う。先に消しておかないと、
      // 過去に一度使ったキーが永久に再利用できなくなる。
      await tx.idempotencyKey.deleteMany({
        where: {
          actorAccountId: input.actorAccountId,
          key: input.key,
          expiresAt: { lte: input.now },
        },
      });

      // createMany + skipDuplicates で「取れたら 1、取れなければ 0」を得る。
      // 例外に頼らないのは、一意制約違反と他のエラーを取り違えないため。
      const created = await tx.idempotencyKey.createMany({
        data: [
          {
            actorAccountId: input.actorAccountId,
            key: input.key,
            requestDigest: input.requestDigest,
            status: 'in_progress',
            // ⚠️ created_at も呼び出し側の時計から入れる。
            //    DB の now() 既定に任せると、expires_at（呼び出し側の時計）と
            //    別の時計で書かれた 2 つの時刻が同じ行に並ぶ。
            //    CHECK idempotency_keys_expires_after_creation は
            //    その 2 つを比べるので、時計が違えば意味のない比較になる。
            createdAt: input.now,
            expiresAt: input.expiresAt,
          },
        ],
        skipDuplicates: true,
      });

      if (created.count === 1) {
        return { claimed: true, existing: null };
      }

      const row = await tx.idempotencyKey.findUnique({
        where: {
          actorAccountId_key: { actorAccountId: input.actorAccountId, key: input.key },
        },
      });
      return { claimed: false, existing: row === null ? null : toRecord(row) };
    });
  }

  async complete(input: {
    actorAccountId: string;
    key: string;
    statusCode: number;
    responseBody: unknown;
  }): Promise<void> {
    await this.prisma.idempotencyKey.update({
      where: {
        actorAccountId_key: { actorAccountId: input.actorAccountId, key: input.key },
      },
      data: {
        status: 'completed',
        statusCode: input.statusCode,
        // Prisma の Json 型は undefined を受け付けないので null へ寄せる。
        responseBody: (input.responseBody ?? null) as never,
        completedAt: new Date(),
      },
    });
  }

  async release(actorAccountId: string, key: string): Promise<void> {
    // 占有だけの行を消す。完了済みの行は消さない
    // （完了しているなら、それは正しい応答として残すべきもの）。
    await this.prisma.idempotencyKey.deleteMany({
      where: { actorAccountId, key, status: 'in_progress' },
    });
  }
}

interface IdempotencyRow {
  readonly requestDigest: string;
  readonly status: string;
  readonly statusCode: number | null;
  readonly responseBody: unknown;
}

function toRecord(row: IdempotencyRow): IdempotencyRecord {
  return {
    requestDigest: row.requestDigest,
    // DB の CHECK 制約でこの 2 値に閉じている。
    state: row.status as IdempotencyState,
    statusCode: row.statusCode,
    responseBody: row.responseBody ?? null,
  };
}
