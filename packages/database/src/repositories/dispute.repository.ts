import type { PrismaClient } from '../../generated/client';
import {
  canAdvanceDispute,
  type DisputeListItem,
  type DisputeListQuery,
  type DisputePort,
  type DisputeReason,
  type DisputeRecord,
  type DisputeStatus,
} from '@sengoku/domain';

interface Row {
  id: string;
  orderId: string;
  paymentId: string | null;
  provider: string;
  disputeRef: string;
  status: string;
  reason: string;
  amount: number;
  currency: string;
  openedAt: Date;
  evidenceDueAt: Date | null;
  closedAt: Date | null;
  refundId: string | null;
}

function toRecord(row: Row): DisputeRecord {
  return {
    id: row.id,
    orderId: row.orderId,
    paymentId: row.paymentId,
    provider: row.provider,
    disputeRef: row.disputeRef,
    status: row.status as DisputeStatus,
    reason: row.reason as DisputeReason,
    amount: row.amount,
    currency: row.currency,
    openedAt: row.openedAt,
    evidenceDueAt: row.evidenceDueAt,
    closedAt: row.closedAt,
    refundId: row.refundId,
  };
}

/** ⚠️ 決着したら時刻が要る（DB の CHECK と同じ判断をここでも持つ）。 */
function closedAtFor(status: DisputeStatus, occurredAt: Date): Date | null {
  return status === 'won' || status === 'lost' ? occurredAt : null;
}

export class PrismaDisputeRepository implements DisputePort {
  constructor(private readonly prisma: PrismaClient) {}

  async findByRef(provider: string, disputeRef: string): Promise<DisputeRecord | null> {
    const row = await this.prisma.paymentDispute.findUnique({
      where: { provider_disputeRef: { provider, disputeRef } },
    });
    return row === null ? null : toRecord(row);
  }

  async listByOrder(orderId: string): Promise<readonly DisputeRecord[]> {
    const rows = await this.prisma.paymentDispute.findMany({
      where: { orderId },
      orderBy: { openedAt: 'desc' },
    });
    return rows.map(toRecord);
  }

  async list(query: DisputeListQuery): Promise<{
    readonly items: readonly DisputeListItem[];
    readonly hasMore: boolean;
  }> {
    /*
      ⚠️ **`closed_at` ではなく状態で分ける。** 「決着したか」の正は状態で、
         `closed_at` はその写しである（DB の CHECK が両者を縛っている）。
         時刻で分けると、片方だけ入った行の扱いが二通りになる。
      ⚠️ **`open` に警告を含める。** 精算を止める条件（`countOpenDisputes`）
         とはわざと違う。あちらは「お支払いを遅らせてよいか」の判断で、
         こちらは「人が見ておくべきか」の一覧である。警告こそ早めに知りたい。
    */
    const CLOSED: readonly DisputeStatus[] = ['won', 'lost'];
    const where =
      query.state === 'all'
        ? {}
        : query.state === 'closed'
          ? { status: { in: [...CLOSED] } }
          : { status: { notIn: [...CLOSED] } };

    /*
      ⚠️ **1 件多く取って、切ったかどうかを見る。** 別に件数を数えると、
         数えた時点と取った時点のあいだに増えて食い違う。
    */
    const rows = await this.prisma.paymentDispute.findMany({
      where,
      orderBy: [
        /*
          ⚠️ **期限の早い順。起きた順にしない。** 起きた順だと、期限が
             明日のものが二枚目に沈む。
          ⚠️ **期限を持たないものは後ろへ。** 既定では NULL が先に来る
             実装もあるため、明示する。
        */
        { evidenceDueAt: { sort: 'asc', nulls: 'last' } },
        { openedAt: 'asc' },
        // ⚠️ 同じ時刻で並びが揺れないように、最後に一意な列を置く。
        { id: 'asc' },
      ],
      take: query.limit + 1,
      select: {
        id: true,
        orderId: true,
        paymentId: true,
        provider: true,
        disputeRef: true,
        status: true,
        reason: true,
        amount: true,
        currency: true,
        openedAt: true,
        evidenceDueAt: true,
        closedAt: true,
        refundId: true,
        /*
          ⚠️ **買った方の情報は引かない。** 注文から取るのは番号と総額まで
             （`UD-503`）。氏名やご連絡先は、注文の画面が本人確認を経て見せる。
        */
        order: {
          select: {
            orderNumber: true,
            totalAmount: true,
            lines: { select: { artworkTitleSnapshot: true }, take: 1 },
          },
        },
      },
    });

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    return {
      items: page.map((row) => ({
        ...toRecord(row),
        orderNumber: row.order.orderNumber,
        // ⚠️ 明細が無い注文は作れない設計だが、来たら空にする（推測で埋めない）。
        artworkTitleSnapshot: row.order.lines[0]?.artworkTitleSnapshot ?? '',
        orderTotalAmount: row.order.totalAmount,
      })),
      hasMore,
    };
  }

  async record(input: {
    readonly id: string;
    readonly orderId: string;
    readonly paymentId: string | null;
    readonly provider: string;
    readonly disputeRef: string;
    readonly status: DisputeStatus;
    readonly reason: DisputeReason;
    readonly amount: number;
    readonly currency: string;
    readonly evidenceDueAt: Date | null;
    readonly occurredAt: Date;
    readonly now: Date;
  }): Promise<{ readonly record: DisputeRecord; readonly advanced: boolean }> {
    return this.prisma.$transaction(async (tx) => {
      /*
        ⚠️ **まず作ってみる。** 「探して無ければ書く」に崩すと、同時に
           届いた知らせで 2 行できる。`(provider, dispute_ref)` の UNIQUE を
           歯止めにして、重複したら読み直す。
      */
      const created = await tx.paymentDispute.createMany({
        data: [
          {
            id: input.id,
            orderId: input.orderId,
            paymentId: input.paymentId,
            provider: input.provider,
            disputeRef: input.disputeRef,
            status: input.status,
            reason: input.reason,
            amount: input.amount,
            currency: input.currency,
            openedAt: input.occurredAt,
            evidenceDueAt: input.evidenceDueAt,
            closedAt: closedAtFor(input.status, input.occurredAt),
            createdAt: input.now,
            updatedAt: input.now,
          },
        ],
        skipDuplicates: true,
      });

      const existing = await tx.paymentDispute.findUniqueOrThrow({
        where: {
          provider_disputeRef: { provider: input.provider, disputeRef: input.disputeRef },
        },
      });

      if (created.count === 1) {
        return { record: toRecord(existing), advanced: true };
      }

      const from = existing.status as DisputeStatus;
      /*
        ⚠️ **決着からは戻さない。** 事業者の知らせは前後して届く。素直に
           上書きすると、決着した争いが開き直り、精算が理由なく止まり続ける。
      */
      const allowed = canAdvanceDispute(from, input.status);
      if (!allowed.ok || from === input.status) {
        return { record: toRecord(existing), advanced: false };
      }

      const updated = await tx.paymentDispute.update({
        where: { id: existing.id },
        data: {
          status: input.status,
          /*
            ⚠️ **理由は上書きする。** 事業者が途中で分類を変えることがある。
               最後に言われたものが、いま争われている理由である。
          */
          reason: input.reason,
          amount: input.amount,
          /*
            ⚠️ **期限は届いた値で上書きする。ただし消さない。**
               決着の知らせには期限が入っていないことがある。素直に
               `null` を書くと、**あとから「いつまでだったのか」を
               読めなくなる**。
          */
          evidenceDueAt: input.evidenceDueAt ?? existing.evidenceDueAt,
          closedAt: closedAtFor(input.status, input.occurredAt),
          updatedAt: input.now,
        },
      });
      return { record: toRecord(updated), advanced: true };
    });
  }

  async attachRefund(input: {
    readonly disputeId: string;
    readonly refundId: string;
    readonly now: Date;
  }): Promise<boolean> {
    // ⚠️ 条件付き更新。すでに紐づいていたら上書きしない。
    const updated = await this.prisma.paymentDispute.updateMany({
      where: { id: input.disputeId, refundId: null, status: 'lost' },
      data: { refundId: input.refundId, updatedAt: input.now },
    });
    return updated.count === 1;
  }
}
