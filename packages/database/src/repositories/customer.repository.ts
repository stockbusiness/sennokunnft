import {
  type AccountNotePort,
  type AccountNoteRecord,
  type CustomerDirectoryPort,
  type CustomerEntitlement,
  type CustomerOrderRow,
  type CustomerRefundRow,
  type CustomerSummary,
  type DuplicateCandidate,
  type DuplicateSignal,
  type EmailChangeRequestPort,
  type EmailChangeRequestRecord,
  type EmailChangeStatus,
  type EntitlementStatus,
  type IdentityVerificationMethod,
} from '@sengoku/domain';
import { Prisma } from '../../generated/client';
import type { PrismaClient } from '../../generated/client';

/**
 * 顧客サポートのための読み取り（実運営 指示書 P1-1）。
 *
 * ⚠️ **氏名とメールアドレスの平文を返さない**（`UD-503`）。本システムは
 * そもそも平文を持っていない。`SELECT` に列が無いのは、持っていないから。
 *
 * ⚠️ **持ち主を付け替える口を実装しない**（指示書 §11）。口が無ければ、
 * あとから足す人がまずここを読み、理由に行き当たる。
 */
export class PrismaCustomerDirectoryRepository implements CustomerDirectoryPort {
  constructor(private readonly prisma: PrismaClient) {}

  async findByEmailHash(emailHash: string, limit: number): Promise<readonly CustomerSummary[]> {
    const rows = await this.prisma.account.findMany({
      where: { emailHash },
      orderBy: [{ createdAt: 'asc' }],
      take: limit,
      select: { id: true },
    });
    return this.summarize(rows.map((row: { id: string }) => row.id));
  }

  async findByCommonUserId(
    commonUserId: string,
    limit: number,
  ): Promise<readonly CustomerSummary[]> {
    const rows = await this.prisma.account.findMany({
      where: { commonUserId },
      orderBy: [{ createdAt: 'asc' }],
      take: limit,
      select: { id: true },
    });
    return this.summarize(rows.map((row: { id: string }) => row.id));
  }

  async findByAccountId(accountId: string): Promise<CustomerSummary | null> {
    const found = await this.summarize([accountId]);
    return found[0] ?? null;
  }

  /**
   * 注文番号から辿る。
   *
   * ⚠️ **問い合わせの入口はここがいちばん多い。** 「注文番号しか控えて
   * いない」という方に、番号だけで応対できるようにする。
   */
  async findByOrderNumber(orderNumber: string): Promise<CustomerSummary | null> {
    const order = await this.prisma.order.findFirst({
      where: { orderNumber },
      select: { accountId: true },
    });
    return order === null ? null : this.findByAccountId(order.accountId);
  }

  async entitlements(accountId: string, limit: number): Promise<readonly CustomerEntitlement[]> {
    const rows = await this.prisma.entitlement.findMany({
      where: { accountId },
      orderBy: [{ createdAt: 'desc' }],
      take: limit,
      /*
        ⚠️ **`claim_token_hash` を選ばない。** 選ばなければ、画面へ
           流れる道がそもそも無い。
      */
      select: {
        id: true,
        serialNo: true,
        status: true,
        walletDeliveryStatus: true,
        claimedAt: true,
        walletDeliveredAt: true,
        order: { select: { orderNumber: true } },
        artwork: { select: { title: true } },
      },
    });
    return rows.map(
      (row: {
        id: string;
        serialNo: number;
        status: string;
        walletDeliveryStatus: string;
        claimedAt: Date | null;
        walletDeliveredAt: Date | null;
        order: { orderNumber: string };
        artwork: { title: string };
      }): CustomerEntitlement => ({
        id: row.id,
        orderNumber: row.order.orderNumber,
        artworkTitle: row.artwork.title,
        serialNo: row.serialNo,
        status: row.status as EntitlementStatus,
        walletDeliveryStatus: row.walletDeliveryStatus,
        claimedAt: row.claimedAt,
        walletDeliveredAt: row.walletDeliveredAt,
      }),
    );
  }

  async orders(accountId: string, limit: number): Promise<readonly CustomerOrderRow[]> {
    const rows = await this.prisma.order.findMany({
      where: { accountId },
      orderBy: [{ createdAt: 'desc' }],
      take: limit,
      select: {
        id: true,
        orderNumber: true,
        status: true,
        paymentStatus: true,
        refundStatus: true,
        totalAmount: true,
        createdAt: true,
        paidAt: true,
      },
    });
    return rows;
  }

  async refunds(accountId: string, limit: number): Promise<readonly CustomerRefundRow[]> {
    const rows = await this.prisma.refund.findMany({
      where: { order: { accountId } },
      orderBy: [{ createdAt: 'desc' }],
      take: limit,
      select: {
        id: true,
        amount: true,
        reason: true,
        status: true,
        createdAt: true,
        order: { select: { orderNumber: true } },
      },
    });
    return rows.map(
      (row: {
        id: string;
        amount: number;
        reason: string;
        status: string;
        createdAt: Date;
        order: { orderNumber: string };
      }): CustomerRefundRow => ({
        id: row.id,
        orderNumber: row.order.orderNumber,
        amount: row.amount,
        reason: row.reason,
        status: row.status,
        createdAt: row.createdAt,
      }),
    );
  }

  /**
   * 同じ方かもしれないアカウント。
   *
   * ⚠️ **候補まで。統合はしない**（指示書 §11）。
   *
   * ⚠️ **自分自身を候補にしない。** 混ざると、画面で「自分と同じ人です」と
   * 出て、読んだ人が混乱する。
   */
  async duplicateCandidates(
    accountId: string,
    limit: number,
  ): Promise<readonly DuplicateCandidate[]> {
    const self = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: { emailHash: true, commonUserId: true },
    });
    if (self === null) {
      return [];
    }
    /*
      ⚠️ **どちらも無ければ候補は出せない。** 手がかりが無い状態で
         「近い人」を探し始めると、無関係な人が並ぶ。
    */
    if (self.emailHash === null && self.commonUserId === null) {
      return [];
    }

    const rows = await this.prisma.account.findMany({
      where: {
        id: { not: accountId },
        OR: [
          ...(self.emailHash === null ? [] : [{ emailHash: self.emailHash }]),
          ...(self.commonUserId === null ? [] : [{ commonUserId: self.commonUserId }]),
        ],
      },
      orderBy: [{ createdAt: 'asc' }],
      take: limit,
      select: {
        id: true,
        emailHash: true,
        commonUserId: true,
        status: true,
        createdAt: true,
        _count: { select: { orders: true, entitlements: true } },
      },
    });

    return rows.map(
      (row: {
        id: string;
        emailHash: string | null;
        commonUserId: string | null;
        status: string;
        createdAt: Date;
        _count: { orders: number; entitlements: number };
      }): DuplicateCandidate => {
        const signals: DuplicateSignal[] = [];
        if (self.emailHash !== null && row.emailHash === self.emailHash) {
          signals.push('email_hash');
        }
        if (self.commonUserId !== null && row.commonUserId === self.commonUserId) {
          signals.push('common_user_id');
        }
        return {
          accountId: row.id,
          /*
            ⚠️ **伏せた表記も持っていない。** 平文が無いので作れない。
               照合値が一致したことだけが手がかりで、それは `signals` に出る。
          */
          maskedEmail: null,
          commonUserId: row.commonUserId,
          status: row.status as 'active' | 'suspended',
          orderCount: row._count.orders,
          entitlementCount: row._count.entitlements,
          signals,
          createdAt: row.createdAt,
        };
      },
    );
  }

  /**
   * 要約を作る。
   *
   * ⚠️ **金額は SQL で合計する。** 行を全部持ってきてアプリで足すと、
   * 注文が増えた方の画面だけ重くなる。
   */
  private async summarize(accountIds: readonly string[]): Promise<readonly CustomerSummary[]> {
    if (accountIds.length === 0) {
      return [];
    }
    const ids = [...accountIds];

    const [accounts, orderStats, refundStats, entitlementStats] = await Promise.all([
      this.prisma.account.findMany({
        where: { id: { in: ids } },
        // ⚠️ `emailHash` は要約に含めない。伏せた表記を作る材料にならない。
        select: { id: true, commonUserId: true, status: true },
      }),
      this.prisma.$queryRaw<
        readonly {
          account_id: string;
          order_count: bigint;
          paid_amount: bigint;
          first_at: Date | null;
          last_at: Date | null;
        }[]
      >(Prisma.sql`
        SELECT "account_id",
               count(*)::bigint AS order_count,
               -- ⚠️ 支払いが成立したものだけを足す。申し込んだだけの注文を
               --    売上に混ぜない。
               coalesce(sum("total_amount") FILTER (WHERE "payment_status" = 'succeeded'), 0)::bigint
                 AS paid_amount,
               min("created_at") AS first_at,
               max("created_at") AS last_at
          FROM "orders"
         WHERE "account_id" = ANY(${ids}::uuid[])
         GROUP BY "account_id"
      `),
      this.prisma.$queryRaw<readonly { account_id: string; refunded: bigint }[]>(Prisma.sql`
        SELECT o."account_id",
               -- ⚠️ 成立した返金だけ。申請中を引くと、返っていないお金を
               --    返したことにしてしまう。
               coalesce(sum(r."amount") FILTER (WHERE r."status" = 'succeeded'), 0)::bigint
                 AS refunded
          FROM "refunds" r
          JOIN "orders" o ON o."id" = r."order_id"
         WHERE o."account_id" = ANY(${ids}::uuid[])
         GROUP BY o."account_id"
      `),
      this.prisma.$queryRaw<
        readonly { account_id: string; total: bigint; unclaimed: bigint }[]
      >(Prisma.sql`
        SELECT "account_id",
               count(*)::bigint AS total,
               -- ⚠️ 取り消したものを「未受取」に数えない。返金済みの品を
               --    「まだお受け取りいただけていません」と案内することになる。
               count(*) FILTER (WHERE "status" = 'issued')::bigint AS unclaimed
          FROM "entitlements"
         WHERE "account_id" = ANY(${ids}::uuid[])
         GROUP BY "account_id"
      `),
    ]);

    const orderBy = new Map(orderStats.map((row) => [row.account_id, row]));
    const refundBy = new Map(refundStats.map((row) => [row.account_id, row]));
    const entitlementBy = new Map(entitlementStats.map((row) => [row.account_id, row]));

    // ⚠️ 渡された順に返す。並びが変わると、呼び出し元の期待が崩れる。
    return ids.flatMap((id): CustomerSummary[] => {
      const account = accounts.find((row: { id: string }) => row.id === id);
      if (account === undefined) {
        return [];
      }
      const orders = orderBy.get(id);
      const refunds = refundBy.get(id);
      const entitlements = entitlementBy.get(id);
      return [
        {
          accountId: id,
          // ⚠️ 平文を持っていないので、伏せた表記も作れない。
          maskedEmail: null,
          commonUserId: account.commonUserId,
          status: account.status as 'active' | 'suspended',
          orderCount: Number(orders?.order_count ?? 0n),
          paidAmount: Number(orders?.paid_amount ?? 0n),
          refundedAmount: Number(refunds?.refunded ?? 0n),
          entitlementCount: Number(entitlements?.total ?? 0n),
          unclaimedCount: Number(entitlements?.unclaimed ?? 0n),
          firstOrderAt: orders?.first_at ?? null,
          lastOrderAt: orders?.last_at ?? null,
        },
      ];
    });
  }
}

/** アカウント単位の申し送り。⚠️ 更新・削除の口を作らない（申し送りは履歴）。 */
export class PrismaAccountNoteRepository implements AccountNotePort {
  constructor(private readonly prisma: PrismaClient) {}

  async add(input: {
    readonly accountId: string;
    readonly authorAccountId: string;
    readonly body: string;
    readonly now: Date;
  }): Promise<string> {
    const row = await this.prisma.accountNote.create({
      data: {
        accountId: input.accountId,
        authorAccountId: input.authorAccountId,
        body: input.body,
        createdAt: input.now,
      },
      select: { id: true },
    });
    return row.id;
  }

  async list(accountId: string, limit: number): Promise<readonly AccountNoteRecord[]> {
    return this.prisma.accountNote.findMany({
      where: { accountId },
      orderBy: [{ createdAt: 'desc' }],
      take: limit,
      select: { id: true, authorAccountId: true, body: true, createdAt: true },
    });
  }
}

/**
 * ご連絡先の変更申請。
 *
 * ⚠️ **ここでアドレスは変わらない。** 変えるのは認証基盤側で人が行う。
 * この表は「申し出があった」「本人確認をした」「向こうで変えた」の記録。
 */
export class PrismaEmailChangeRequestRepository implements EmailChangeRequestPort {
  constructor(private readonly prisma: PrismaClient) {}

  async open(input: {
    readonly accountId: string;
    readonly requestedMaskedEmail: string;
    readonly requestedEmailHash: string;
    readonly openedByAccountId: string;
    readonly now: Date;
  }): Promise<string> {
    const row = await this.prisma.emailChangeRequest.create({
      data: {
        accountId: input.accountId,
        requestedMaskedEmail: input.requestedMaskedEmail,
        requestedEmailHash: input.requestedEmailHash,
        openedByAccountId: input.openedByAccountId,
        createdAt: input.now,
        updatedAt: input.now,
      },
      select: { id: true },
    });
    return row.id;
  }

  async findById(id: string): Promise<EmailChangeRequestRecord | null> {
    const row = await this.prisma.emailChangeRequest.findUnique({ where: { id } });
    return row === null ? null : toRecord(row);
  }

  async list(accountId: string, limit: number): Promise<readonly EmailChangeRequestRecord[]> {
    const rows = await this.prisma.emailChangeRequest.findMany({
      where: { accountId },
      orderBy: [{ createdAt: 'desc' }],
      take: limit,
    });
    return rows.map(toRecord);
  }

  /**
   * 本人確認を記録する。
   *
   * ⚠️ **決着した申請には書き込ませない。** 条件付き UPDATE にしてある
   * ので、同時に 2 人が押しても片方しか通らない。
   */
  async verify(input: {
    readonly id: string;
    readonly method: IdentityVerificationMethod;
    readonly note: string | null;
    readonly actorAccountId: string;
    readonly now: Date;
  }): Promise<void> {
    await this.prisma.emailChangeRequest.updateMany({
      where: { id: input.id, status: { in: ['requested', 'identity_verified'] } },
      data: {
        status: 'identity_verified',
        verificationMethod: input.method,
        verifiedByAccountId: input.actorAccountId,
        verifiedAt: input.now,
        note: input.note,
        updatedAt: input.now,
      },
    });
  }

  async settle(input: {
    readonly id: string;
    readonly status: 'completed' | 'rejected';
    readonly note: string | null;
    readonly actorAccountId: string;
    readonly now: Date;
  }): Promise<void> {
    await this.prisma.emailChangeRequest.updateMany({
      where: { id: input.id, status: { in: ['requested', 'identity_verified'] } },
      data: {
        status: input.status,
        settledByAccountId: input.actorAccountId,
        settledAt: input.now,
        note: input.note,
        updatedAt: input.now,
      },
    });
  }
}

function toRecord(row: {
  id: string;
  accountId: string;
  requestedMaskedEmail: string;
  status: string;
  verificationMethod: string | null;
  verifiedByAccountId: string | null;
  verifiedAt: Date | null;
  settledByAccountId: string | null;
  settledAt: Date | null;
  note: string | null;
  openedByAccountId: string;
  createdAt: Date;
}): EmailChangeRequestRecord {
  return {
    id: row.id,
    accountId: row.accountId,
    requestedMaskedEmail: row.requestedMaskedEmail,
    status: row.status as EmailChangeStatus,
    verificationMethod: row.verificationMethod as IdentityVerificationMethod | null,
    verifiedByAccountId: row.verifiedByAccountId,
    verifiedAt: row.verifiedAt,
    settledByAccountId: row.settledByAccountId,
    settledAt: row.settledAt,
    note: row.note,
    openedByAccountId: row.openedByAccountId,
    createdAt: row.createdAt,
  };
}
