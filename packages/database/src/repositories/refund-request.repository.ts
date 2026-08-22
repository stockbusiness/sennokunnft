import type { PrismaClient } from '../../generated/client';
import type {
  CreatorInquiryPort,
  CreatorInquiryRecord,
  CreatorReceivablePort,
  ClawbackBearer,
  EntitlementDisposition,
  ReceivableRecord,
  ReceivableStatus,
  RefundCategory,
  RefundRequestEventRecord,
  RefundRequestPort,
  RefundRequestQuery,
  RefundRequestReason,
  RefundRequestRecord,
  RefundRequestStatus,
} from '@sengoku/domain';

/**
 * 返金の申請と審査（方針整理 2026-08-22）。
 *
 * ⚠️ **状態を進めるのは、必ず条件付き更新。** 「読んでから書く」にすると、
 * 2 人が同時に承認したときに両方通り、**二重返金の入口になる**。
 *
 * ⚠️ **証跡は追記のみ。** 直す口も消す口もここに書かない（DB の
 * トリガーが拒むが、口そのものを作らないほうが早い）。
 */
export class PrismaRefundRequestRepository implements RefundRequestPort {
  constructor(private readonly prisma: PrismaClient) {}

  async find(id: string): Promise<RefundRequestRecord | null> {
    const row = await this.prisma.refundRequest.findUnique({ where: { id } });
    return row === null ? null : toRecord(row);
  }

  async list(query: RefundRequestQuery): Promise<readonly RefundRequestRecord[]> {
    const rows = await this.prisma.refundRequest.findMany({
      where: {
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.orderId === undefined ? {} : { orderId: query.orderId }),
        /*
          ⚠️ **作家さまで絞るときは注文をたどる。** 申請そのものは作家さまを
             持たない——持たせると、注文と食い違う行を作れてしまう。
        */
        ...(query.creatorAccountId === undefined
          ? {}
          : { order: { creatorAccountId: query.creatorAccountId } }),
      },
      orderBy: { createdAt: 'desc' },
      take: query.limit,
    });
    return rows.map(toRecord);
  }

  async findOpenByOrder(orderId: string): Promise<RefundRequestRecord | null> {
    const row = await this.prisma.refundRequest.findFirst({
      // ⚠️ 決着していないもの。DB の部分 UNIQUE 索引と同じ条件にする。
      where: { orderId, status: { notIn: ['rejected', 'executed'] } },
    });
    return row === null ? null : toRecord(row);
  }

  async create(input: {
    readonly id: string;
    readonly orderId: string;
    readonly reason: RefundRequestReason;
    readonly category: RefundCategory;
    readonly amount: number;
    readonly isFullRefund: boolean;
    readonly entitlementDisposition: EntitlementDisposition;
    readonly requestedByAccountId: string | null;
    readonly buyerStatement: string | null;
    readonly status: RefundRequestStatus;
    readonly now: Date;
  }): Promise<RefundRequestRecord> {
    const row = await this.prisma.refundRequest.create({
      data: {
        id: input.id,
        orderId: input.orderId,
        status: input.status,
        reason: input.reason,
        category: input.category,
        amount: input.amount,
        isFullRefund: input.isFullRefund,
        entitlementDisposition: input.entitlementDisposition,
        requestedByAccountId: input.requestedByAccountId,
        buyerStatement: input.buyerStatement,
        createdAt: input.now,
        updatedAt: input.now,
      },
    });
    return toRecord(row);
  }

  async transition(input: {
    readonly id: string;
    readonly from: readonly RefundRequestStatus[];
    readonly to: RefundRequestStatus;
    readonly patch?:
      | {
          readonly reviewedByAccountId?: string | undefined;
          readonly approvedByAccountId?: string | undefined;
          readonly dualApprovalRequired?: boolean | undefined;
          readonly approvedAsException?: boolean | undefined;
          readonly clawbackBearer?: ClawbackBearer | undefined;
          readonly clawbackBearerOverridden?: boolean | undefined;
          readonly entitlementDisposition?: EntitlementDisposition | undefined;
          readonly amount?: number | undefined;
          readonly isFullRefund?: boolean | undefined;
          readonly note?: string | undefined;
          readonly rejectionNote?: string | undefined;
          readonly refundId?: string | undefined;
        }
      | undefined;
    readonly now: Date;
  }): Promise<boolean> {
    /*
      ⚠️ **`from` を必ず指定する。** どの状態からでも進める更新にすると、
         決着した申請を蘇らせられる。
    */
    const updated = await this.prisma.refundRequest.updateMany({
      where: { id: input.id, status: { in: [...input.from] } },
      data: {
        status: input.to,
        ...(input.patch ?? {}),
        updatedAt: input.now,
      },
    });
    return updated.count === 1;
  }

  async listEvents(requestId: string, limit: number): Promise<readonly RefundRequestEventRecord[]> {
    const rows = await this.prisma.refundRequestEvent.findMany({
      where: { requestId },
      // ⚠️ 古い順。読む人は「どう進んだか」を上から追う。
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    return rows.map((row) => ({
      id: row.id,
      action: row.action,
      actorAccountId: row.actorAccountId,
      summary: (row.summary ?? {}) as Record<string, unknown>,
      createdAt: row.createdAt,
    }));
  }

  async appendEvent(input: {
    readonly id: string;
    readonly requestId: string;
    readonly action: string;
    readonly actorAccountId: string | null;
    readonly summary: Record<string, unknown>;
    readonly now: Date;
  }): Promise<void> {
    await this.prisma.refundRequestEvent.create({
      data: {
        id: input.id,
        requestId: input.requestId,
        action: input.action,
        actorAccountId: input.actorAccountId,
        summary: input.summary as never,
        createdAt: input.now,
      },
    });
  }
}

export class PrismaCreatorInquiryRepository implements CreatorInquiryPort {
  constructor(private readonly prisma: PrismaClient) {}

  async findByRequest(requestId: string): Promise<CreatorInquiryRecord | null> {
    const row = await this.prisma.creatorRefundInquiry.findUnique({ where: { requestId } });
    return row === null ? null : toInquiry(row);
  }

  async listForCreator(
    creatorAccountId: string,
    limit: number,
  ): Promise<readonly CreatorInquiryRecord[]> {
    const rows = await this.prisma.creatorRefundInquiry.findMany({
      where: { creatorAccountId },
      // ⚠️ 期限の近い順。急ぐものを上に置く。
      orderBy: { dueAt: 'asc' },
      take: limit,
    });
    return rows.map(toInquiry);
  }

  async ask(input: {
    readonly id: string;
    readonly requestId: string;
    readonly creatorAccountId: string;
    readonly dueAt: Date;
    readonly now: Date;
  }): Promise<CreatorInquiryRecord> {
    const row = await this.prisma.creatorRefundInquiry.create({
      data: {
        id: input.id,
        requestId: input.requestId,
        creatorAccountId: input.creatorAccountId,
        askedAt: input.now,
        dueAt: input.dueAt,
        createdAt: input.now,
        updatedAt: input.now,
      },
    });
    return toInquiry(row);
  }

  async answer(input: {
    readonly requestId: string;
    readonly creatorAccountId: string;
    readonly answer: string;
    readonly attachmentKeys: readonly string[];
    readonly now: Date;
  }): Promise<boolean> {
    /*
      ⚠️ **条件付き更新。** まだ答えていない行だけを進める。二度目の回答で
         最初の回答が上書きされると、何を根拠に判断したかが失われる。
      ⚠️ **作家さまのIDも条件に入れる。** 入れないと、依頼IDを知っている
         別の方が答えられてしまう。
      ⚠️ **期限は条件に入れない。** 遅れて届いた事実にも値打ちがある。
    */
    const updated = await this.prisma.creatorRefundInquiry.updateMany({
      where: {
        requestId: input.requestId,
        creatorAccountId: input.creatorAccountId,
        answeredAt: null,
      },
      data: {
        answeredAt: input.now,
        answer: input.answer,
        attachmentKeys: [...input.attachmentKeys],
        updatedAt: input.now,
      },
    });
    return updated.count === 1;
  }
}

export class PrismaCreatorReceivableRepository implements CreatorReceivablePort {
  constructor(private readonly prisma: PrismaClient) {}

  async listOutstanding(creatorAccountId: string): Promise<readonly ReceivableRecord[]> {
    const rows = await this.prisma.creatorReceivable.findMany({
      where: { creatorAccountId, status: 'outstanding' },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toReceivable);
  }

  async record(input: {
    readonly id: string;
    readonly creatorAccountId: string;
    readonly orderId: string;
    readonly amount: number;
    readonly now: Date;
  }): Promise<void> {
    /*
      ⚠️ **同じ注文で 2 行作らない。** DB の UNIQUE が最終防壁だが、
         例外で処理を止めない——回収待ちを積めないことで返金が巻き戻る
         ほうが困る。すでにあれば何もしない。
    */
    await this.prisma.creatorReceivable.upsert({
      where: { orderId: input.orderId },
      create: {
        id: input.id,
        creatorAccountId: input.creatorAccountId,
        orderId: input.orderId,
        amount: input.amount,
        createdAt: input.now,
        updatedAt: input.now,
      },
      // ⚠️ 金額を書き換えない。1 回目の記録が正である。
      update: {},
    });
  }

  async settle(input: {
    readonly id: string;
    readonly status: Exclude<ReceivableStatus, 'outstanding'>;
    readonly actorAccountId: string;
    readonly now: Date;
  }): Promise<boolean> {
    // ⚠️ 残っているものだけを進める。二度決着させない。
    const updated = await this.prisma.creatorReceivable.updateMany({
      where: { id: input.id, status: 'outstanding' },
      data: {
        status: input.status,
        settledByAccountId: input.actorAccountId,
        settledAt: input.now,
        updatedAt: input.now,
      },
    });
    return updated.count === 1;
  }
}

function toRecord(row: {
  id: string;
  orderId: string;
  status: string;
  reason: string;
  category: string;
  note: string | null;
  buyerStatement: string | null;
  amount: number;
  isFullRefund: boolean;
  entitlementDisposition: string;
  requestedByAccountId: string | null;
  reviewedByAccountId: string | null;
  approvedByAccountId: string | null;
  dualApprovalRequired: boolean;
  approvedAsException: boolean;
  clawbackBearer: string | null;
  clawbackBearerOverridden: boolean;
  rejectionNote: string | null;
  refundId: string | null;
  createdAt: Date;
  updatedAt: Date;
}): RefundRequestRecord {
  return {
    id: row.id,
    orderId: row.orderId,
    status: row.status as RefundRequestStatus,
    reason: row.reason as RefundRequestReason,
    category: row.category as RefundCategory,
    note: row.note,
    buyerStatement: row.buyerStatement,
    amount: row.amount,
    isFullRefund: row.isFullRefund,
    entitlementDisposition: row.entitlementDisposition as EntitlementDisposition,
    requestedByAccountId: row.requestedByAccountId,
    reviewedByAccountId: row.reviewedByAccountId,
    approvedByAccountId: row.approvedByAccountId,
    dualApprovalRequired: row.dualApprovalRequired,
    approvedAsException: row.approvedAsException,
    clawbackBearer: (row.clawbackBearer ?? null) as ClawbackBearer | null,
    clawbackBearerOverridden: row.clawbackBearerOverridden,
    rejectionNote: row.rejectionNote,
    refundId: row.refundId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toInquiry(row: {
  id: string;
  requestId: string;
  creatorAccountId: string;
  askedAt: Date;
  dueAt: Date;
  answeredAt: Date | null;
  answer: string | null;
  attachmentKeys: string[];
}): CreatorInquiryRecord {
  return {
    id: row.id,
    requestId: row.requestId,
    creatorAccountId: row.creatorAccountId,
    askedAt: row.askedAt,
    dueAt: row.dueAt,
    answeredAt: row.answeredAt,
    answer: row.answer,
    attachmentKeys: row.attachmentKeys,
  };
}

function toReceivable(row: {
  id: string;
  creatorAccountId: string;
  orderId: string;
  amount: number;
  status: string;
  createdAt: Date;
  settledAt: Date | null;
}): ReceivableRecord {
  return {
    id: row.id,
    creatorAccountId: row.creatorAccountId,
    orderId: row.orderId,
    amount: row.amount,
    status: row.status as ReceivableStatus,
    createdAt: row.createdAt,
    settledAt: row.settledAt,
  };
}
