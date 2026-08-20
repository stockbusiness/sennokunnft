import {
  refundStatusAfter,
  type EntitlementStatus,
  type MintJobStatus,
  type RefundContext,
  type RefundInitiator,
  type RefundReason,
  type RefundRecordStatus,
  type RefundRecordView,
  type RefundRepository,
  type RefundSettlement,
  type SettleRefundCommand,
  type StartRefundCommand,
} from '@sengoku/domain';
import type { PrismaClient } from '../../generated/client';

/**
 * 返金リポジトリの Prisma 実装（`UD-104` / `UD-120`）。
 *
 * ⚠️ **決済事業者をこのクラスから呼ばない。** 外部への往復を
 * トランザクションの中へ入れると、その間ずっと注文の行ロックを握る。
 * 送信は呼び出し側（`RefundService`）が、トランザクションの外で行う。
 *
 * ⚠️ **判定をここでやり直さない。** 「返してよいか」は `decideRefund` が
 * 決め、ここは決まったことを書くだけ。2 か所に置くと片方だけ直る。
 */
export class PrismaRefundRepository implements RefundRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listByOrder(orderId: string): Promise<readonly RefundRecordView[]> {
    const rows = await this.prisma.refund.findMany({
      where: { orderId },
      orderBy: [{ createdAt: 'desc' }],
    });
    return rows.map(toView);
  }

  async loadContext(orderId: string): Promise<RefundContext | null> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        totalAmount: true,
        totalCurrency: true,
        paymentStatus: true,
        refundStatus: true,
        refundableUntil: true,
      },
    });
    if (order === null) {
      // ⚠️ 「空の姿」を返さない。返すと、存在しない注文が「未払い」になる。
      return null;
    }

    /*
      戻す先の決済。
      ⚠️ **成功した行だけを見る。** 失敗した試行に返金は投げられない。
         部分 UNIQUE 索引で「1 注文に成功は 1 件」が守られている。
    */
    const payment = await this.prisma.payment.findFirst({
      where: { orderId, status: 'succeeded' },
      orderBy: [{ paidAt: 'desc' }],
      select: {
        id: true,
        credentialId: true,
        providerPaymentRef: true,
        providerChargeRef: true,
        amountRefunded: true,
      },
    });

    const entitlements = await this.prisma.entitlement.findMany({
      where: { orderId },
      select: { status: true },
    });
    const mintJobs = await this.prisma.mintJob.findMany({
      where: { entitlement: { orderId } },
      select: { status: true },
    });

    return {
      orderId: order.id,
      totalAmount: order.totalAmount,
      currency: order.totalCurrency,
      refundableUntil: order.refundableUntil,
      paymentStatus: order.paymentStatus,
      refundStatus: order.refundStatus as RefundContext['refundStatus'],
      amountRefunded: payment?.amountRefunded ?? 0,
      paymentId: payment?.id ?? null,
      credentialId: payment?.credentialId ?? null,
      paymentRef: payment?.providerPaymentRef ?? null,
      chargeRef: payment?.providerChargeRef ?? null,
      entitlementStatus: mostAdvanced(
        entitlements.map((row) => row.status as EntitlementStatus),
        ENTITLEMENT_RANK,
      ),
      mintStatus: mostAdvanced(
        mintJobs.map((row) => row.status as MintJobStatus),
        MINT_RANK,
      ),
    };
  }

  async start(command: StartRefundCommand): Promise<RefundRecordView> {
    const row = await this.prisma.refund.create({
      data: {
        id: command.refundId,
        orderId: command.orderId,
        paymentId: command.paymentId,
        amount: command.amount,
        currency: command.currency,
        reason: command.reason,
        initiatedBy: command.initiatedBy,
        actorAccountId: command.actorAccountId,
        providerRefundRef: command.providerRefundRef,
        note: command.note,
        status: 'requested',
        createdAt: command.now,
        updatedAt: command.now,
      },
    });
    return toView(row);
  }

  async settle(command: SettleRefundCommand): Promise<RefundSettlement> {
    return this.prisma.$transaction(async (tx) => {
      /*
        1. 返金の行を成立させる。
        ⚠️ **条件付き更新にする。** 事業者の知らせとこちらの操作が
           同時に届くことがある。「読んでから書く」にすると両方通る。
      */
      const claimed = await tx.refund.updateMany({
        where: { id: command.refundId, status: 'requested' },
        data: {
          status: 'succeeded',
          providerRefundRef: command.providerRefundRef,
          settledAt: command.now,
          updatedAt: command.now,
        },
      });

      const order = await tx.order.findUniqueOrThrow({
        where: { id: command.orderId },
        select: { totalAmount: true, refundStatus: true },
      });

      if (claimed.count !== 1) {
        // すでに反映済み。⚠️ 二度目は何もしない。いまの姿だけ返す。
        return {
          alreadySettled: true,
          refundStatus: order.refundStatus as RefundSettlement['refundStatus'],
          amountRefunded: command.amountRefundedTotal,
          revokedEntitlements: 0,
          cancelledMintJobs: 0,
          annotatedMintJobs: 0,
          restoredSupply: 0,
        };
      }

      /*
        2. 決済行の返金累計。
        ⚠️ **積み増しではなく置く。** 事業者は累計で持つので、差分で
           積むと知らせが前後して届いたときに合わなくなる。
      */
      const refund = await tx.refund.findUniqueOrThrow({
        where: { id: command.refundId },
        select: { paymentId: true },
      });
      if (refund.paymentId !== null) {
        await tx.payment.update({
          where: { id: refund.paymentId },
          data: { amountRefunded: command.amountRefundedTotal, updatedAt: command.now },
        });
      }

      // 3. 注文の返金状態。⚠️ 全額returnedのときだけ `refunded`。
      const refundStatus = refundStatusAfter(command.amountRefundedTotal, order.totalAmount);
      await tx.order.update({
        where: { id: command.orderId },
        data: { refundStatus, updatedAt: command.now },
      });

      /*
        4. 受取権。
        ⚠️ **受取り済み（`claimed`）は取り消さない。** 受け取った事実は
           起きたことで、記録から消すものではない（`decideRefund` の判断を
           そのまま運んでいる）。
      */
      let revokedEntitlements = 0;
      if (command.revokeEntitlement) {
        const revoked = await tx.entitlement.updateMany({
          where: { orderId: command.orderId, status: 'issued' },
          data: { status: 'revoked', updatedAt: command.now },
        });
        revokedEntitlements = revoked.count;
      }

      /*
        5. 発行ジョブ。
        ⚠️ **`processing` を `cancelled` にしない**（`INV-M4`）。外部へ
           送信済みの可能性があり、多重発行は回復できない。注記だけ足す。
      */
      let cancelledMintJobs = 0;
      if (command.cancelMintJob) {
        const cancelled = await tx.mintJob.updateMany({
          where: { entitlement: { orderId: command.orderId }, status: 'queued' },
          data: { status: 'cancelled', updatedAt: command.now },
        });
        cancelledMintJobs = cancelled.count;
      }

      let annotatedMintJobs = 0;
      if (command.mintNote !== null) {
        const annotated = await tx.mintJob.updateMany({
          where: { entitlement: { orderId: command.orderId }, status: 'processing' },
          data: { note: command.mintNote, updatedAt: command.now },
        });
        annotatedMintJobs = annotated.count;
      }

      /*
        6. 在庫。
        ⚠️ **戻すのは「まだ受取権になっていない枠」だけ。** 決済が確定
           しても在庫は `reserved_count` 側で押さえたまま（決定 A）なので、
           返金したらここを解放する。
        ⚠️ **`issued_count` は減らさない。** これは通し番号の採番でもある。
           減らすと、次に発行した受取権が同じ番号になり、
           `(artwork_id, serial_no)` の UNIQUE で弾かれる。返金した番号は
           使い切りとして扱う——販売枠が 1 つ減るが、番号の重複よりよい。
      */
      let restoredSupply = 0;
      const reservations = await tx.inventoryReservation.findMany({
        where: { orderId: command.orderId, status: { in: ['reserved', 'consumed'] } },
        select: { id: true, artworkId: true, quantity: true },
      });
      for (const reservation of reservations) {
        const released = await tx.inventoryReservation.updateMany({
          // ⚠️ 条件付き更新。二重に戻さない。
          where: { id: reservation.id, status: { in: ['reserved', 'consumed'] } },
          data: { status: 'released', releasedAt: command.now, updatedAt: command.now },
        });
        if (released.count !== 1) {
          continue;
        }
        await tx.artwork.update({
          where: { id: reservation.artworkId },
          data: { reservedCount: { decrement: reservation.quantity }, updatedAt: command.now },
        });
        restoredSupply += reservation.quantity;
      }

      return {
        alreadySettled: false,
        refundStatus,
        amountRefunded: command.amountRefundedTotal,
        revokedEntitlements,
        cancelledMintJobs,
        annotatedMintJobs,
        restoredSupply,
      };
    });
  }

  async fail(input: {
    readonly refundId: string;
    readonly failureCode: string;
    readonly now: Date;
  }): Promise<void> {
    // ⚠️ 行を消さない。「試したが駄目だった」ことを残す。
    await this.prisma.refund.updateMany({
      where: { id: input.refundId, status: 'requested' },
      data: { status: 'failed', failureCode: input.failureCode, updatedAt: input.now },
    });
  }

  async findByProviderRef(providerRefundRef: string): Promise<RefundRecordView | null> {
    const row = await this.prisma.refund.findFirst({ where: { providerRefundRef } });
    return row === null ? null : toView(row);
  }
}

/**
 * 状態の「進み具合」。
 *
 * ⚠️ **1 件でも進んでいれば、注文としてはそこまで進んだとみなす。**
 * 件数や平均で丸めると、発行処理中の 1 件が「まだ何もしていない」に
 * 埋もれ、取り消してはいけないものを取り消す。
 */
const ENTITLEMENT_RANK: Readonly<Record<EntitlementStatus, number>> = {
  revoked: 0,
  expired: 1,
  issued: 2,
  claimed: 3,
};

const MINT_RANK: Readonly<Record<MintJobStatus, number>> = {
  cancelled: 0,
  failed: 1,
  queued: 2,
  processing: 3,
  succeeded: 4,
};

function mostAdvanced<T extends string>(
  values: readonly T[],
  rank: Readonly<Record<T, number>>,
): T | null {
  let best: T | null = null;
  for (const value of values) {
    if (best === null || rank[value] > rank[best]) {
      best = value;
    }
  }
  return best;
}

function toView(row: {
  id: string;
  orderId: string;
  amount: number;
  currency: string;
  reason: string;
  status: string;
  initiatedBy: string;
  actorAccountId: string | null;
  providerRefundRef: string | null;
  note: string | null;
  failureCode: string | null;
  createdAt: Date;
  settledAt: Date | null;
}): RefundRecordView {
  return {
    id: row.id,
    orderId: row.orderId,
    amount: row.amount,
    currency: row.currency,
    // ⚠️ DB の CHECK で語彙を縛ってある。ここで既定へ倒さない。
    reason: row.reason as RefundReason,
    status: row.status as RefundRecordStatus,
    initiatedBy: row.initiatedBy as RefundInitiator,
    actorAccountId: row.actorAccountId,
    providerRefundRef: row.providerRefundRef,
    note: row.note,
    failureCode: row.failureCode,
    createdAt: row.createdAt,
    settledAt: row.settledAt,
  };
}
