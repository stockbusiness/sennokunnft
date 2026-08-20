import type {
  OpenOperationsReviewCommand,
  OperationsReviewOpenCounts,
  OperationsReviewPage,
  OperationsReviewQuery,
  OperationsReviewReasonCode,
  OperationsReviewRecord,
  OperationsReviewRepository,
  OperationsReviewStatus,
  OperationsReviewSubjectType,
} from '@sengoku/domain';
import { Prisma } from '../../generated/client';
import type { PrismaClient } from '../../generated/client';

/**
 * 確認事項を積む。**トランザクションの中からも呼べる**ように、
 * クラスの外へ出してある。
 *
 * ⚠️ **返金のトランザクションと同じところで積む。** あとから別呼び出しに
 * すると、そのあいだに落ちた分の確認事項が誰にも気づかれず消える。
 *
 * ⚠️ **`ON CONFLICT DO NOTHING`。** 「読んでから書く」にすると、
 * 並行した Webhook が両方とも「無い」を読んで両方書く。
 *
 * ⚠️ **既存行を上書きしない。** 最初に気づいた時刻と理由を残す。
 * あとから来た同じ知らせで `detail` を書き換えると、人が見たときに
 * 「いつからの話か」が分からなくなる。
 *
 * @returns 新しく積んだら `true`、すでにあったら `false`
 */
export async function openOperationsReview(
  db: OperationsReviewExecutor,
  command: OpenOperationsReviewCommand,
): Promise<boolean> {
  const inserted = await db.$executeRaw(Prisma.sql`
    INSERT INTO "operations_reviews"
      ("id", "subject_type", "subject_id", "order_id", "reason_code",
       "detail", "created_at", "updated_at")
    VALUES
      (gen_random_uuid(), ${command.subjectType}, ${command.subjectId}::uuid,
       ${command.orderId}::uuid, ${command.reasonCode}, ${command.detail},
       ${command.now}, ${command.now})
    ON CONFLICT ("subject_type", "subject_id", "reason_code") DO NOTHING
  `);
  return inserted === 1;
}

/** トランザクションクライアントでも通る最小の口。 */
export type OperationsReviewExecutor = Pick<PrismaClient, '$executeRaw'>;

/**
 * 運用確認キューの永続化（M3a）。
 *
 * ⚠️ **`open` は例外を投げない。** 呼び出し元は返金のトランザクションの
 * 中にいる。ここで落ちると**返金そのものが巻き戻る**——返金はもう決済
 * 事業者へ届いているのに、こちらの記録だけが消える。
 *
 * ⚠️ **同じ対象・同じ理由を 2 行にしない。** 返金の Webhook は同じものが
 * 何度も届く。そのたびに確認事項が増えると「いま何件残っているか」が
 * 意味を失い、誰も見なくなる。
 */
export class PrismaOperationsReviewRepository implements OperationsReviewRepository {
  constructor(private readonly prisma: PrismaClient) {}

  open(command: OpenOperationsReviewCommand): Promise<boolean> {
    return openOperationsReview(this.prisma, command);
  }

  async list(query: OperationsReviewQuery): Promise<OperationsReviewPage> {
    const cursor = query.cursor;
    const rows = await this.prisma.operationsReview.findMany({
      where: {
        ...(query.statuses.length > 0 ? { status: { in: [...query.statuses] } } : {}),
        ...(query.reasonCodes.length > 0 ? { reasonCode: { in: [...query.reasonCodes] } } : {}),
        ...(cursor === null
          ? {}
          : {
              OR: [
                { createdAt: { lt: cursor.at } },
                { createdAt: cursor.at, id: { lt: cursor.id } },
              ],
            }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      // 続きがあるかを知るために 1 件多く読む。
      take: query.limit + 1,
    });

    const items = rows.slice(0, query.limit).map(toRecord);
    const last = rows.length > query.limit ? items[items.length - 1] : undefined;
    return {
      items,
      nextCursor: last === undefined ? null : { at: last.createdAt, id: last.id },
    };
  }

  /**
   * 未対応の件数を理由ごとに数える。
   *
   * ⚠️ **0 件の理由も返す。** `GROUP BY` は 1 件も無いものを返さないので、
   * そのまま渡すと監視から項目ごと消える。「欄が無い」と「0 件」は違う。
   */
  async countOpen(): Promise<OperationsReviewOpenCounts> {
    const grouped = await this.prisma.operationsReview.groupBy({
      by: ['reasonCode'],
      where: { status: 'open' },
      _count: { _all: true },
    });
    const counts: Record<OperationsReviewReasonCode, number> = {
      partial_refund_entitlement_unresolved: 0,
      wallet_revocation_recipient_unresolved: 0,
      wallet_revocation_payload_conflict: 0,
    };
    for (const row of grouped) {
      counts[row.reasonCode as OperationsReviewReasonCode] = row._count._all;
    }
    return counts;
  }

  async resolve(input: {
    readonly id: string;
    readonly actorAccountId: string;
    readonly note: string | null;
    readonly now: Date;
  }): Promise<boolean> {
    // ⚠️ 条件付き更新。すでに対応済みの行を、あとから別の人が
    //    上書きして「誰が対応したか」を書き換えられないようにする。
    const updated = await this.prisma.operationsReview.updateMany({
      where: { id: input.id, status: 'open' },
      data: {
        status: 'resolved',
        resolvedByAccountId: input.actorAccountId,
        resolvedAt: input.now,
        resolutionNote: input.note,
        updatedAt: input.now,
      },
    });
    return updated.count === 1;
  }
}

function toRecord(row: {
  id: string;
  subjectType: string;
  subjectId: string;
  orderId: string | null;
  reasonCode: string;
  detail: string;
  status: string;
  resolvedByAccountId: string | null;
  resolvedAt: Date | null;
  resolutionNote: string | null;
  createdAt: Date;
  updatedAt: Date;
}): OperationsReviewRecord {
  return {
    id: row.id,
    // ⚠️ DB の CHECK で語彙を縛ってある。ここで既定へ倒さない。
    subjectType: row.subjectType as OperationsReviewSubjectType,
    subjectId: row.subjectId,
    orderId: row.orderId,
    reasonCode: row.reasonCode as OperationsReviewReasonCode,
    detail: row.detail,
    status: row.status as OperationsReviewStatus,
    resolvedByAccountId: row.resolvedByAccountId,
    resolvedAt: row.resolvedAt,
    resolutionNote: row.resolutionNote,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
