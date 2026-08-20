import type {
  PayoutCandidate,
  PayoutClawback,
  PayoutLineView,
  PayoutRepository,
  PayoutStatus,
  PayoutView,
  SavePayoutDraftCommand,
  TransferFeeBearer,
} from '@sengoku/domain';
import type { PrismaClient } from '../../generated/client';

/**
 * 精算リポジトリの Prisma 実装（`UD-119`）。
 *
 * ⚠️ **金額をここで計算し直さない。** 合計は `buildPayoutDraft` が決めた値を
 * そのまま書く。2 か所で計算すると、片方だけ直ったときに明細と合計が
 * 食い違う——しかも気づくのは作家さまからの問い合わせになる。
 *
 * ⚠️ **`confirmed` 以降を書き換える経路を足さない**
 * （`docs/SETTLEMENT_AND_REFUND.md` §4）。訂正は次の期間での調整で行う。
 */
export class PrismaPayoutRepository implements PayoutRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async list(query: {
    readonly limit: number;
    readonly periodKey?: string | undefined;
    readonly creatorAccountId?: string | undefined;
    readonly status?: PayoutStatus | undefined;
  }): Promise<readonly PayoutView[]> {
    const rows = await this.prisma.payout.findMany({
      where: {
        ...(query.periodKey === undefined ? {} : { periodKey: query.periodKey }),
        ...(query.creatorAccountId === undefined
          ? {}
          : { creatorAccountId: query.creatorAccountId }),
        ...(query.status === undefined ? {} : { status: query.status }),
      },
      // 新しい期間から。同じ期間なら作られた順。
      orderBy: [{ periodKey: 'desc' }, { createdAt: 'desc' }],
      take: query.limit,
      include: { _count: { select: { lines: true } } },
    });
    return rows.map(toView);
  }

  async findById(payoutId: string): Promise<PayoutView | null> {
    const row = await this.prisma.payout.findUnique({
      where: { id: payoutId },
      include: { _count: { select: { lines: true } } },
    });
    return row === null ? null : toView(row);
  }

  async findByPeriod(creatorAccountId: string, periodKey: string): Promise<PayoutView | null> {
    const row = await this.prisma.payout.findUnique({
      where: { creatorAccountId_periodKey: { creatorAccountId, periodKey } },
      include: { _count: { select: { lines: true } } },
    });
    return row === null ? null : toView(row);
  }

  async listLines(payoutId: string): Promise<readonly PayoutLineView[]> {
    const rows = await this.prisma.payoutLine.findMany({
      where: { payoutId },
      // 差し戻しを後ろへ。売上を見てから差し引きを見る並びにする。
      orderBy: [{ isClawback: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((row) => ({
      id: row.id,
      orderId: row.orderId,
      orderNumber: row.orderNumber,
      artworkTitleSnapshot: row.artworkTitleSnapshot,
      grossAmount: row.grossAmount,
      feeRateBps: row.feeRateBps,
      feeAmount: row.feeAmount,
      netAmount: row.netAmount,
      isClawback: row.isClawback,
    }));
  }

  async listCandidates(input: {
    readonly creatorAccountId: string;
    readonly periodStart: Date;
    readonly periodEnd: Date;
  }): Promise<readonly PayoutCandidate[]> {
    const rows = await this.prisma.order.findMany({
      where: {
        creatorAccountId: input.creatorAccountId,
        paymentStatus: 'succeeded',
        // ⚠️ 半開区間。終了の瞬間は次の期間のもの。
        paidAt: { gte: input.periodStart, lt: input.periodEnd },
        /*
          ⚠️ **返金された注文は入れない。** 一部返金も外す——作家さまへ
             いくら渡すかは、返した額を差し引いてから決める話で、
             機械が案分してよいものではない（`UD-104` の「一部返金は
             自動処理しない」と同じ向き）。
        */
        refundStatus: 'none',
        /*
          ⚠️ **すでにどこかの精算に載っている注文は入れない。** DB の
             部分 UNIQUE 索引が最後に止めるが、ここで外しておかないと
             下書きの作成そのものが失敗する。
        */
        payoutLines: { none: { isClawback: false } },
      },
      orderBy: [{ paidAt: 'asc' }],
      select: {
        id: true,
        orderNumber: true,
        creatorAccountId: true,
        paidAt: true,
        totalAmount: true,
        platformFeeRateBps: true,
        platformFeeAmount: true,
        creatorAmount: true,
        refundableUntil: true,
        lines: { select: { artworkTitleSnapshot: true }, take: 1 },
      },
    });

    return rows.map((row) => ({
      orderId: row.id,
      orderNumber: row.orderNumber,
      creatorAccountId: row.creatorAccountId,
      // ⚠️ 明細が無い注文は作れない設計だが、来たら空にする（推測で埋めない）。
      artworkTitleSnapshot: row.lines[0]?.artworkTitleSnapshot ?? '',
      // ⚠️ `paidAt` が無い succeeded は CHECK 制約で作れない。
      paidAt: row.paidAt ?? row.refundableUntil ?? new Date(0),
      grossAmount: row.totalAmount,
      feeRateBps: row.platformFeeRateBps,
      feeAmount: row.platformFeeAmount,
      netAmount: row.creatorAmount,
      refundableUntil: row.refundableUntil,
    }));
  }

  async listClawbacks(creatorAccountId: string): Promise<readonly PayoutClawback[]> {
    /*
      確定済みの精算に載っていたのに、あとから返金された注文。
      ⚠️ **一度差し引いた注文を二度引かない。** 差し戻しの行がすでに
         あるものを除く。二度引くと、作家さまから取りすぎる。
    */
    const rows = await this.prisma.payoutLine.findMany({
      where: {
        isClawback: false,
        payout: {
          creatorAccountId,
          // ⚠️ 下書きのままの精算は対象外。まだ払っていない。
          status: { in: ['confirmed', 'paid'] },
        },
        order: { refundStatus: { in: ['refunded', 'partially_refunded'] } },
        // すでに差し戻しの行があるものを除く。
        NOT: { order: { payoutLines: { some: { isClawback: true } } } },
      },
      select: {
        orderId: true,
        orderNumber: true,
        artworkTitleSnapshot: true,
        netAmount: true,
      },
    });

    return rows.map((row) => ({
      orderId: row.orderId,
      orderNumber: row.orderNumber,
      artworkTitleSnapshot: row.artworkTitleSnapshot,
      // ⚠️ 正の数で返す。符号はドメイン側が付ける。
      netAmount: row.netAmount,
    }));
  }

  async countOpenRefundWindows(payoutId: string, now: Date): Promise<number> {
    /*
      ⚠️ **この精算の明細そのものから数える。** 候補の絞り込み
         （`listCandidates`）で数えると、下書きを保存した直後は 0 件になる
         （もうこの精算に載っているため）。
      ⚠️ **期限が付いていない注文も「開いている」と数える。** 分からない
         ものを、分かったことにしない。
    */
    return this.prisma.payoutLine.count({
      where: {
        payoutId,
        isClawback: false,
        order: { OR: [{ refundableUntil: null }, { refundableUntil: { gt: now } }] },
      },
    });
  }

  async carriedInAmount(creatorAccountId: string, previousPeriodKey: string): Promise<number> {
    const previous = await this.prisma.payout.findUnique({
      where: { creatorAccountId_periodKey: { creatorAccountId, periodKey: previousPeriodKey } },
      select: { status: true, carriedOutAmount: true },
    });
    /*
      ⚠️ **下書きのままの前月から繰り越さない。** 下書きは作り直せるので、
         金額が動く。動く値を今月の計算へ入れると、今月の下書きも
         静かに変わる。
    */
    if (previous === null || previous.status === 'draft') {
      return 0;
    }
    return previous.carriedOutAmount;
  }

  async listCreatorsForPeriod(input: {
    readonly periodStart: Date;
    readonly periodEnd: Date;
    readonly previousPeriodKey: string;
  }): Promise<readonly string[]> {
    const sold = await this.prisma.order.findMany({
      where: {
        paymentStatus: 'succeeded',
        paidAt: { gte: input.periodStart, lt: input.periodEnd },
        refundStatus: 'none',
      },
      distinct: ['creatorAccountId'],
      select: { creatorAccountId: true },
    });

    /*
      ⚠️ **繰越だけの作家さまも含める。** 今月の売上が 0 でも、前月からの
         繰越があれば支払う月かもしれない。売上だけで絞ると、繰り越した額が
         いつまでも支払われない。
    */
    const carried = await this.prisma.payout.findMany({
      where: {
        periodKey: input.previousPeriodKey,
        status: { in: ['confirmed', 'paid'] },
        NOT: { carriedOutAmount: 0 },
      },
      select: { creatorAccountId: true },
    });

    return [
      ...new Set([
        ...sold.map((row) => row.creatorAccountId),
        ...carried.map((row) => row.creatorAccountId),
      ]),
    ];
  }

  async saveDraft(command: SavePayoutDraftCommand): Promise<PayoutView> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.payout.findUnique({
        where: {
          creatorAccountId_periodKey: {
            creatorAccountId: command.creatorAccountId,
            periodKey: command.periodKey,
          },
        },
        select: { id: true, status: true },
      });

      /*
        ⚠️ **`draft` のときだけ置き換える。** 締めたあとに金額が動くと、
           作家さまへ渡した明細と食い違う。呼び出し側でも見ているが、
           ここでも見る——同時に押されたときに片方が通る形にしない。
      */
      if (existing !== null && existing.status !== 'draft') {
        throw new PayoutNotEditableError();
      }

      if (existing !== null) {
        // 作り直し。⚠️ 明細ごと入れ替える（`ON DELETE CASCADE`）。
        await tx.payout.delete({ where: { id: existing.id } });
      }

      const created = await tx.payout.create({
        data: {
          id: command.payoutId,
          creatorAccountId: command.creatorAccountId,
          periodKey: command.periodKey,
          periodStart: command.periodStart,
          periodEnd: command.periodEnd,
          dueAt: command.dueAt,
          status: 'draft',
          currency: command.currency,
          grossAmount: command.grossAmount,
          feeAmount: command.feeAmount,
          refundedAmount: command.refundedAmount,
          carriedInAmount: command.carriedInAmount,
          netAmount: command.netAmount,
          carriedOutAmount: command.carriedOutAmount,
          minimumPayoutAmount: command.minimumPayoutAmount,
          transferFeeBearer: command.transferFeeBearer,
          createdAt: command.now,
          updatedAt: command.now,
          lines: {
            create: command.lines.map((line) => ({
              id: line.id,
              orderId: line.orderId,
              orderNumber: line.orderNumber,
              artworkTitleSnapshot: line.artworkTitleSnapshot,
              grossAmount: line.grossAmount,
              feeRateBps: line.feeRateBps,
              feeAmount: line.feeAmount,
              netAmount: line.netAmount,
              isClawback: line.isClawback,
              createdAt: command.now,
            })),
          },
        },
        include: { _count: { select: { lines: true } } },
      });

      return toView(created);
    });
  }

  async advance(input: {
    readonly payoutId: string;
    readonly from: PayoutStatus;
    readonly to: PayoutStatus;
    readonly actorAccountId: string;
    readonly now: Date;
  }): Promise<PayoutView | null> {
    /*
      ⚠️ **条件付き更新にする。** 「読んでから書く」にすると、同時に押された
         「確定」が 2 回通る。`updateMany` の件数で成否を見る。
    */
    const updated = await this.prisma.payout.updateMany({
      where: { id: input.payoutId, status: input.from },
      data: {
        status: input.to,
        ...(input.to === 'confirmed' ? { confirmedAt: input.now } : {}),
        ...(input.to === 'paid'
          ? { paidAt: input.now, paidByAccountId: input.actorAccountId }
          : {}),
        updatedAt: input.now,
      },
    });
    if (updated.count !== 1) {
      return null;
    }
    return this.findById(input.payoutId);
  }
}

/** 締めたあとの精算を作り直そうとした。⚠️ 握りつぶさない。 */
export class PayoutNotEditableError extends Error {
  public override readonly name = 'PayoutNotEditableError';
  constructor() {
    super('payout is not editable');
  }
}

function toView(row: {
  id: string;
  creatorAccountId: string;
  periodKey: string;
  periodStart: Date;
  periodEnd: Date;
  dueAt: Date;
  status: string;
  currency: string;
  grossAmount: number;
  feeAmount: number;
  refundedAmount: number;
  carriedInAmount: number;
  netAmount: number;
  carriedOutAmount: number;
  minimumPayoutAmount: number;
  transferFeeBearer: string;
  confirmedAt: Date | null;
  paidAt: Date | null;
  paidByAccountId: string | null;
  createdAt: Date;
  _count: { lines: number };
}): PayoutView {
  return {
    id: row.id,
    creatorAccountId: row.creatorAccountId,
    periodKey: row.periodKey,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    dueAt: row.dueAt,
    // ⚠️ DB の CHECK で語彙を縛ってある。ここで既定へ倒さない。
    status: row.status as PayoutStatus,
    currency: row.currency,
    grossAmount: row.grossAmount,
    feeAmount: row.feeAmount,
    refundedAmount: row.refundedAmount,
    carriedInAmount: row.carriedInAmount,
    netAmount: row.netAmount,
    carriedOutAmount: row.carriedOutAmount,
    minimumPayoutAmount: row.minimumPayoutAmount,
    transferFeeBearer: row.transferFeeBearer as TransferFeeBearer,
    confirmedAt: row.confirmedAt,
    paidAt: row.paidAt,
    paidByAccountId: row.paidByAccountId,
    lineCount: row._count.lines,
    createdAt: row.createdAt,
  };
}
