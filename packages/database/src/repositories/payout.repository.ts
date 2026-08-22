import type {
  PayoutCandidate,
  NegativeCarryView,
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
      確定済み・お支払い済みの精算に載っていたのに、あとから返金された注文。

      ⚠️ **作家さま負担の返金だけを拾う**（決定 2026-08-22）。以前はここに
         事由の条件が無く、**こちらの不具合で返金した分まで作家さまの次回の
         売上から引いていた**。誰が被るかは `refunds.clawback_bearer` にある。

      ⚠️ **返した額に応じて差し引く。** 以前は注文の作家さま配分を丸ごと
         引いていた。一部返金ができるようになった以上、それでは**返して
         いない分まで取り立てる**ことになる。

      ⚠️ **すでに引いた分を差し引く。** 同じ注文が月をまたいで 2 度返金
         されることがある。「差し戻しの行があれば対象外」にすると、
         2 度目が拾えない。**引くべき合計と、引いた合計の差**を返す。

      ⚠️ **もとの配分を超えて引かない。** 端数の丸めが積み上がると、
         払った額より多く取り立てることが起こりうる。上限で止める。
    */
    const rows = await this.prisma.$queryRaw<
      {
        order_id: string;
        order_number: string;
        artwork_title_snapshot: string;
        outstanding: bigint;
      }[]
    >`
      WITH paid_lines AS (
        SELECT
          l."order_id",
          l."order_number",
          l."artwork_title_snapshot",
          l."fee_rate_bps",
          l."net_amount"
        FROM "payout_lines" l
        JOIN "payouts" p ON p."id" = l."payout_id"
        WHERE l."is_clawback" = false
          AND p."creator_account_id" = ${creatorAccountId}::uuid
          -- ⚠️ 下書きのままの精算は対象外。まだ払っていない。
          AND p."status" IN ('confirmed', 'paid')
      ),
      -- 作家さまが被る返金だけを、注文ごとに合計する。
      creator_refunds AS (
        SELECT r."order_id", SUM(r."amount")::bigint AS refunded
        FROM "refunds" r
        WHERE r."clawback_bearer" = 'creator'
          AND r."status" = 'succeeded'
        GROUP BY r."order_id"
      ),
      -- すでに差し引いた分。⚠️ 明細ではマイナスなので符号を戻す。
      already AS (
        SELECT l."order_id", SUM(-l."net_amount")::bigint AS clawed
        FROM "payout_lines" l
        JOIN "payouts" p ON p."id" = l."payout_id"
        WHERE l."is_clawback" = true
          AND p."creator_account_id" = ${creatorAccountId}::uuid
        GROUP BY l."order_id"
      )
      SELECT
        pl."order_id",
        pl."order_number",
        pl."artwork_title_snapshot",
        (
          LEAST(
            /*
              返した額の作家さま配分。⚠️ **注文時に焼き付けた率で割る。**
                 いまの手数料率で割ると、率を変えた月に過去の注文が動く。
            */
            cr.refunded - FLOOR(cr.refunded * pl."fee_rate_bps" / 10000),
            -- ⚠️ もとの配分を超えない。
            pl."net_amount"
          ) - COALESCE(a.clawed, 0)
        )::bigint AS outstanding
      FROM paid_lines pl
      JOIN creator_refunds cr ON cr."order_id" = pl."order_id"
      LEFT JOIN already a ON a."order_id" = pl."order_id"
      WHERE (
        LEAST(
          cr.refunded - FLOOR(cr.refunded * pl."fee_rate_bps" / 10000),
          pl."net_amount"
        ) - COALESCE(a.clawed, 0)
      ) > 0
    `;

    return rows.map((row) => ({
      orderId: row.order_id,
      orderNumber: row.order_number,
      artworkTitleSnapshot: row.artwork_title_snapshot,
      // ⚠️ 正の数で返す。符号はドメイン側が付ける。
      netAmount: Number(row.outstanding),
    }));
  }

  async listNegativeCarries(limit: number): Promise<readonly NegativeCarryView[]> {
    /*
      繰越がマイナスのまま残っている作家さま（決定 2026-08-22）。

      ⚠️ **その作家さまの「いちばん新しい精算」だけを見る。** 途中の月が
         マイナスでも、あとで売れて解消していれば残っていない。
      ⚠️ **下書きは見ない。** 確定していない数字で人を呼び出さない。
    */
    const rows = await this.prisma.$queryRaw<
      { creator_account_id: string; period_key: string; carried_out_amount: number; since: Date }[]
    >`
      SELECT DISTINCT ON (p."creator_account_id")
        p."creator_account_id",
        p."period_key",
        p."carried_out_amount",
        COALESCE(p."confirmed_at", p."updated_at") AS since
      FROM "payouts" p
      WHERE p."status" IN ('confirmed', 'paid')
      ORDER BY p."creator_account_id", p."period_key" DESC
    `;

    return (
      rows
        .filter((row) => row.carried_out_amount < 0)
        // ⚠️ 大きいものから。放置してよい額かどうかを、まず額で判断する。
        .sort((left, right) => left.carried_out_amount - right.carried_out_amount)
        .slice(0, limit)
        .map((row) => ({
          creatorAccountId: row.creator_account_id,
          periodKey: row.period_key,
          // ⚠️ 正の数で返す。符号は画面が付ける。
          outstandingAmount: Math.abs(row.carried_out_amount),
          since: row.since,
        }))
    );
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

  async countOpenDisputes(payoutId: string): Promise<number> {
    /*
      ⚠️ **警告は数えない。** カード会社が調べ始めただけで、申し立てに
         ならずに消えることもある。数えると、消えた警告のぶんまで精算を
         止め、作家さまへのお支払いが理由なく遅れる。
      ⚠️ **差し戻しの明細は見ない。** あちらはもう返金された注文で、
         いま争われている注文ではない。
    */
    return this.prisma.payoutLine.count({
      where: {
        payoutId,
        isClawback: false,
        order: { disputes: { some: { status: { in: ['needs_response', 'under_review'] } } } },
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
