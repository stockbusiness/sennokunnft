import type { ConsistencyCounts, JobHeartbeat, OperationsCounts } from '@sengoku/domain';
import { CONSISTENCY_SAMPLE_LIMIT } from '@sengoku/domain';
import { Prisma } from '../../generated/client';
import type { PrismaClient } from '../../generated/client';

/**
 * 運営が朝いちばんに見る数（実運営 指示書 P0-6）。
 *
 * ⚠️ **判定を持たない。数えるだけ。** どこを赤くするかはドメインが決める。
 * ここで色まで決めると、しきい値を変えるのに SQL を触ることになる。
 *
 * ⚠️ **個人を特定できる値を返さない。** 返すのは件数と識別子まで。
 * ダッシュボードは運営が広く開く画面で、置いたものはそのまま目に触れる。
 */
export class PrismaOperationsRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * 数え上げる。
   *
   * ⚠️ **「本日」は JST の 1 日。** 保存は UTC なので、境界をここで作る。
   * UTC の 0 時で切ると、日本の朝 9 時前の注文が前日に混ざる。
   */
  async counts(now: Date): Promise<OperationsCounts> {
    const { start, end } = jstDayRange(now);

    const [
      todayOrderCount,
      paidAggregate,
      todayPaymentFailedCount,
      issuancePendingCount,
      issuanceFailedCount,
      walletDeliveryPendingCount,
      walletDeliveryFailedCount,
      operationsReviewOpenCount,
      notificationPendingCount,
      notificationFailedCount,
      integrationFailureCount,
      lastWebhook,
    ] = await Promise.all([
      this.prisma.order.count({ where: { createdAt: { gte: start, lt: end } } }),
      this.prisma.payment.aggregate({
        where: { status: 'succeeded', paidAt: { gte: start, lt: end } },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.payment.count({
        where: { status: 'failed', updatedAt: { gte: start, lt: end } },
      }),
      /*
        発行待ち。⚠️ **「支払い済みで、まだ試行上限に達していない注文」**。
           `next_attempt_at` が入っている＝失敗して待っている行も含む。
      */
      this.prisma.order.count({
        where: { paymentStatus: 'succeeded', issuanceNextAttemptAt: { not: null } },
      }),
      // 打ち切り。⚠️ 試行上限に達し、自動では二度と発行されない注文。
      this.prisma.$queryRaw<readonly { count: bigint }[]>(Prisma.sql`
        SELECT count(*)::bigint AS count
          FROM "orders"
         WHERE "payment_status" = 'succeeded'
           AND "issuance_attempt_count" >= 5
           AND "issuance_next_attempt_at" IS NULL
           AND EXISTS (
             SELECT 1 FROM "order_lines" l
              WHERE l."order_id" = "orders"."id"
                AND l."quantity" > (
                  SELECT count(*) FROM "entitlements" e WHERE e."order_line_id" = l."id"
                )
           )
      `),
      this.prisma.walletDeliveryOutbox.count({
        where: { status: { in: ['PENDING', 'PROCESSING'] } },
      }),
      this.prisma.walletDeliveryOutbox.count({ where: { status: { in: ['FAILED', 'DEAD'] } } }),
      this.prisma.operationsReview.count({ where: { status: 'open' } }),
      this.prisma.notificationDelivery.count({
        where: { status: { in: ['PENDING', 'PROCESSING'] } },
      }),
      this.prisma.notificationDelivery.count({ where: { status: { in: ['FAILED', 'DEAD'] } } }),
      /*
        外部サービスの接続確認。
        ⚠️ **直近 24 時間に絞る。** 過去の失敗をいつまでも数えると、
           一度直した相手が永久に赤いままになる。
      */
      this.prisma.integrationConnectionCheck.count({
        where: { succeeded: false, executedAt: { gte: new Date(now.getTime() - 86_400_000) } },
      }),
      this.prisma.webhookEvent.findFirst({
        orderBy: [{ receivedAt: 'desc' }],
        select: { receivedAt: true },
      }),
    ]);

    return {
      todayOrderCount,
      todayPaidAmount: paidAggregate._sum.amount ?? 0,
      todayPaidCount: paidAggregate._count._all,
      todayPaymentFailedCount,
      issuancePendingCount,
      issuanceFailedCount: Number(issuanceFailedCount[0]?.count ?? 0n),
      walletDeliveryPendingCount,
      walletDeliveryFailedCount,
      operationsReviewOpenCount,
      notificationPendingCount,
      notificationFailedCount,
      integrationFailureCount,
      lastWebhookReceivedAt: lastWebhook?.receivedAt ?? null,
    };
  }

  /**
   * 時計仕掛けの生死。
   *
   * ⚠️ **記録の無い種別も返す。** 返さないと、画面から項目ごと消え、
   * 「動いていない」ではなく「そんな処理は無い」に見える。
   */
  async heartbeats(jobKeys: readonly string[]): Promise<readonly JobHeartbeat[]> {
    const rows = await this.prisma.jobRun.findMany({ where: { jobKey: { in: [...jobKeys] } } });
    const byKey = new Map(rows.map((row) => [row.jobKey, row]));
    return jobKeys.map((jobKey) => {
      const row = byKey.get(jobKey);
      return {
        jobKey,
        lastSucceededAt: row?.lastSucceededAt ?? null,
        lastFailedAt: row?.lastFailedAt ?? null,
        lastOutcome: (row?.lastOutcome as JobHeartbeat['lastOutcome']) ?? null,
      };
    });
  }

  /** 時計仕掛けの結果を記録する。⚠️ 種別ごとに 1 行を上書きする。 */
  async recordJobRun(input: {
    readonly jobKey: string;
    readonly outcome: 'succeeded' | 'failed';
    readonly pickedCount?: number | undefined;
    readonly errorCode?: string | undefined;
    readonly now: Date;
  }): Promise<void> {
    const succeeded = input.outcome === 'succeeded';
    await this.prisma.jobRun.upsert({
      where: { jobKey: input.jobKey },
      create: {
        jobKey: input.jobKey,
        lastStartedAt: input.now,
        lastSucceededAt: succeeded ? input.now : null,
        lastFailedAt: succeeded ? null : input.now,
        lastOutcome: input.outcome,
        lastErrorCode: input.errorCode ?? null,
        lastPickedCount: input.pickedCount ?? null,
        updatedAt: input.now,
      },
      update: {
        lastStartedAt: input.now,
        /*
          ⚠️ **失敗しても `last_succeeded_at` を消さない。** 消すと
             「最後にいつ成功したか」が失われる。それこそが見たい値である。
        */
        ...(succeeded ? { lastSucceededAt: input.now } : { lastFailedAt: input.now }),
        lastOutcome: input.outcome,
        lastErrorCode: input.errorCode ?? null,
        ...(succeeded ? { lastPickedCount: input.pickedCount ?? null } : {}),
        updatedAt: input.now,
      },
    });
  }

  /**
   * 記録どうしの食い違いを探す。
   *
   * ⚠️ **直さない。数えるだけ。** 黙って直すと、なぜ食い違ったのかが
   * 分からないまま同じことが繰り返される。
   */
  async consistency(): Promise<ConsistencyCounts> {
    const limit = CONSISTENCY_SAMPLE_LIMIT;

    const [paid, drift, revoked, claimed, unmasked] = await Promise.all([
      // 支払い済みなのに受取権が数量ぶん無い注文。
      this.prisma.$queryRaw<readonly { id: string }[]>(Prisma.sql`
        SELECT DISTINCT o."id"
          FROM "orders" o
          JOIN "order_lines" l ON l."order_id" = o."id"
         WHERE o."payment_status" = 'succeeded'
           AND o."refund_status" = 'none'
           AND l."quantity" > (
             SELECT count(*) FROM "entitlements" e WHERE e."order_line_id" = l."id"
           )
         LIMIT ${limit}
      `),
      /*
        発行済み数と受取権の実数の食い違い。
        ⚠️ **取り消した受取権も数える。** 通し番号は使い切りで、
           取り消しても `issued_count` は戻さない決まりのため。
      */
      this.prisma.$queryRaw<readonly { id: string }[]>(Prisma.sql`
        SELECT a."id"
          FROM "artworks" a
         WHERE a."issued_count" <> (
           SELECT count(*) FROM "entitlements" e WHERE e."artwork_id" = a."id"
         )
         LIMIT ${limit}
      `),
      // 取り消したのに Wallet へ取消を送っていない受取権（M3a）。
      this.prisma.$queryRaw<readonly { id: string }[]>(Prisma.sql`
        SELECT e."id"
          FROM "entitlements" e
         WHERE e."status" = 'revoked'
           AND e."claimed_by_common_user_id" IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM "wallet_delivery_outbox" g
              WHERE g."entitlement_id" = e."id" AND g."event_type" = 'entitlement.granted'
           )
           AND NOT EXISTS (
             SELECT 1 FROM "wallet_delivery_outbox" r
              WHERE r."entitlement_id" = e."id" AND r."event_type" = 'entitlement.revoked'
           )
         LIMIT ${limit}
      `),
      // 受取記録があるのに配送の行が 1 件も無い受取権。
      this.prisma.$queryRaw<readonly { id: string }[]>(Prisma.sql`
        SELECT e."id"
          FROM "entitlements" e
         WHERE e."status" = 'claimed'
           AND NOT EXISTS (
             SELECT 1 FROM "wallet_delivery_outbox" w WHERE w."entitlement_id" = e."id"
           )
         LIMIT ${limit}
      `),
      /*
        伏せていない宛先。
        ⚠️ **DB の CHECK があるので本来 0 件。** 1 件でもあれば、
           制約を迂回した経路があるということ（`UD-503`）。
      */
      this.prisma.$queryRaw<readonly { id: string }[]>(Prisma.sql`
        SELECT "id"
          FROM "notification_deliveries"
         WHERE "masked_recipient" IS NOT NULL
           AND "masked_recipient" NOT LIKE '%*%'
         LIMIT ${limit}
      `),
    ]);

    return {
      paidWithoutEntitlements: paid.map((row) => row.id),
      supplyDrift: drift.map((row) => row.id),
      revokedWithoutWalletNotice: revoked.map((row) => row.id),
      claimedWithoutDelivery: claimed.map((row) => row.id),
      unmaskedRecipient: unmasked.map((row) => row.id),
    };
  }
}

/**
 * JST の 1 日の境界を UTC で作る。
 *
 * ⚠️ **UTC の 0 時で切らない。** 日本の朝 9 時前の注文が前日に混ざる。
 * 運営が「今日の売上」を見るとき、それは JST の今日である。
 */
function jstDayRange(now: Date): { readonly start: Date; readonly end: Date } {
  const JST_OFFSET_MS = 9 * 60 * 60_000;
  const jst = new Date(now.getTime() + JST_OFFSET_MS);
  const startJst = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate());
  return {
    start: new Date(startJst - JST_OFFSET_MS),
    end: new Date(startJst - JST_OFFSET_MS + 86_400_000),
  };
}
