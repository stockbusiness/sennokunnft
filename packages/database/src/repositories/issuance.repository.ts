import {
  err,
  ok,
  domainError,
  isIssuanceDue,
  ISSUANCE_MAX_ATTEMPTS,
  planIssuance,
  reconcileSupply,
  scheduleIssuanceRetry,
  type ClaimTokenPort,
  type DomainError,
  type EntitlementIssuanceRepository,
  type IssuanceCandidate,
  type IssuanceOutcome,
  type IssuanceRetry,
  type Result,
  type SupplyReconciliation,
} from '@sengoku/domain';
import type { PrismaClient } from '../../generated/client';

/**
 * 受取権の発行（P0-1）。
 *
 * **決済が済んだ注文を受取権に変える、唯一の本番の経路。** これまで
 * 受取権を作っていたのは試験と staging の Fixture だけで、本番では
 * 1 件も作られていなかった。
 *
 * ⚠️ **平文の受取トークンをここから返さない。** 保存するのはハッシュだけで、
 * 購入者はご自分の画面から受取URLを**発行し直して**受け取る
 * （`POST /api/v1/entitlements/:id/claim-token`）。発行時に平文を持ち回すと、
 * ログ・監査・通知のどこかに残る道ができる。
 */
export class PrismaEntitlementIssuanceRepository implements EntitlementIssuanceRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly tokens: ClaimTokenPort,
  ) {}

  async listPending(limit: number, now: Date): Promise<IssuanceCandidate[]> {
    /*
      ⚠️ **「発行が要る注文」を表から引かず、注文と受取権から導く。**
         決済が済んでいて、受取権の数が注文明細の数量に足りない注文が対象。
         待ち行列の行を信じると、行の入れ忘れがそのまま「永久に発行されない
         注文」になる。導出なら、取りこぼしても次の掃き出しで拾える。
    */
    const rows = await this.prisma.order.findMany({
      where: {
        paymentStatus: 'succeeded',
        fulfillmentStatus: { not: 'fulfilled' },
        // ⚠️ 上限を使い切った注文は拾わない。人手に回っている。
        issuanceAttemptCount: { lt: ISSUANCE_MAX_ATTEMPTS },
      },
      select: {
        id: true,
        orderNumber: true,
        issuanceNextAttemptAt: true,
        issuanceAttemptCount: true,
      },
      // ⚠️ 古い注文から。待たせている人を先に片づける。
      orderBy: { paidAt: 'asc' },
      // 時刻の判定はドメインが持つので、少し多めに取ってから絞る。
      take: limit * 2,
    });

    return rows
      .filter((row) =>
        isIssuanceDue(
          { nextAttemptAt: row.issuanceNextAttemptAt, attemptCount: row.issuanceAttemptCount },
          now,
        ),
      )
      .slice(0, limit)
      .map((row) => ({ orderId: row.id, orderNumber: row.orderNumber }));
  }

  async issueForOrder(orderId: string, now: Date): Promise<Result<IssuanceOutcome, DomainError>> {
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        select: {
          id: true,
          orderNumber: true,
          accountId: true,
          paymentStatus: true,
          lines: {
            select: { id: true, artworkId: true, quantity: true },
          },
        },
      });

      if (order === null) {
        return err(domainError('ENTITLEMENT_ORDER_NOT_FOUND', 'order does not exist'));
      }
      if (order.paymentStatus !== 'succeeded') {
        /*
          ⚠️ **決済が済んでいない注文に受取権を作らない。** ここを緩めると、
             失敗した決済や期限切れの注文からも権利が生まれる。
        */
        return err(domainError('ENTITLEMENT_ORDER_NOT_PAID', 'payment is not settled'));
      }

      const entitlementIds: string[] = [];
      let issued = 0;

      for (const line of order.lines) {
        /*
          ⚠️ **作品行をロックしてから数える。** ロックを取らずに数えると、
             同時に走った 2 本が同じ「不足数」を読み、両方が作る。
             ロックは作品ごと——同じ作品を買った別の注文とも直列化する。
        */
        await tx.$queryRaw`SELECT id FROM "artworks" WHERE id = ${line.artworkId}::uuid FOR UPDATE`;

        const counters = await tx.artwork.findUniqueOrThrow({
          where: { id: line.artworkId },
          select: { maxSupply: true, reservedCount: true, issuedCount: true },
        });

        // ⚠️ 実物を数える。「何枚作ったか」を別に覚えて信じない。
        const alreadyIssued = await tx.entitlement.count({ where: { orderLineId: line.id } });

        const plan = planIssuance({ quantity: line.quantity, alreadyIssued, counters });
        if (!plan.ok) {
          return plan;
        }
        if (plan.value.missing === 0) {
          // 同じ知らせの 2 回目。作るものが無いだけで、失敗ではない。
          continue;
        }

        await tx.artwork.update({
          where: { id: line.artworkId },
          data: {
            reservedCount: plan.value.counters.reservedCount,
            issuedCount: plan.value.counters.issuedCount,
          },
        });

        for (const unit of plan.value.units) {
          /*
            ⚠️ **1 権利 1 レコード。** 数量をまとめて 1 枚にしない。
               受取・配送・返金はどれも 1 枚ごとに状態を持つ。
            ⚠️ 平文のトークンはここで捨てる。保存するのはハッシュだけ。
          */
          const created = await tx.entitlement.create({
            data: {
              orderId: order.id,
              orderLineId: line.id,
              artworkId: line.artworkId,
              accountId: order.accountId,
              serialNo: unit.serialNo,
              unitIndex: unit.unitIndex,
              claimTokenHash: this.tokens.issue().tokenHash,
              status: 'issued',
              createdAt: now,
              updatedAt: now,
            },
            select: { id: true },
          });
          entitlementIds.push(created.id);
          issued += 1;
        }
      }

      /*
        ⚠️ **全明細が揃ってから `fulfilled` にする。** 途中で落ちた注文を
           「済んだ」と記録すると、掃き出しが二度と拾わなくなる。
      */
      await tx.order.update({
        where: { id: order.id },
        data: {
          fulfillmentStatus: 'fulfilled',
          // 成功したので、失敗の跡を消す。
          issuanceAttemptCount: 0,
          issuanceNextAttemptAt: null,
          issuanceLastError: null,
          updatedAt: now,
        },
      });

      return ok({
        orderId: order.id,
        orderNumber: order.orderNumber,
        issued,
        entitlementIds,
      });
    });
  }

  async recordFailure(input: {
    readonly orderId: string;
    readonly code: string;
    readonly now: Date;
  }): Promise<IssuanceRetry> {
    /*
      ⚠️ **加算を DB の中で 1 手に済ませる。** 「読んで、足して、書く」に
         すると、同時に 2 本走ったときに両方が同じ値を読み、2 回失敗したのに
         1 回しか数えられない。数え落とすと、上限に達しない失敗が
         いつまでも再試行され続ける。
    */
    const updated = await this.prisma.order.update({
      where: { id: input.orderId },
      data: {
        issuanceAttemptCount: { increment: 1 },
        // ⚠️ こちらで決めた符号だけ。例外の本文をそのまま入れない。
        issuanceLastError: input.code,
      },
      select: { issuanceAttemptCount: true },
    });

    // 加算後の値から 1 を引くと「この失敗より前に何回試したか」になる。
    const retry = scheduleIssuanceRetry(updated.issuanceAttemptCount - 1, input.now);

    await this.prisma.order.update({
      where: { id: input.orderId },
      data: { issuanceNextAttemptAt: retry.nextAttemptAt },
    });

    return retry;
  }

  async reconcile(): Promise<SupplyReconciliation[]> {
    /*
      ⚠️ **受取権を数え直して、カウンタと突き合わせる。** 片方だけを見ても
         ずれには気づけない。ずれの向きで原因が分かれる——カウンタが多ければ
         発行の取りこぼし、受取権が多ければ二重発行。
    */
    const rows = await this.prisma.artwork.findMany({
      where: { OR: [{ issuedCount: { gt: 0 } }, { entitlements: { some: {} } }] },
      select: {
        id: true,
        issuedCount: true,
        _count: { select: { entitlements: true } },
      },
    });

    return reconcileSupply(
      rows.map((row) => ({
        artworkId: row.id,
        issuedCount: row.issuedCount,
        entitlementCount: row._count.entitlements,
      })),
    );
  }
}
