import type {
  NotificationEnqueueInput,
  NotificationEnqueueOutcome,
  NotificationEventType,
  NotificationFailureInput,
  NotificationOutboxPort,
  NotificationRecord,
  NotificationStatus,
  NotificationSubjectType,
} from '@sengoku/domain';
import { Prisma } from '../../generated/client';
import type { PrismaClient } from '../../generated/client';

/** トランザクションの中でも外でも使える最小の口。 */
type Executor = Pick<PrismaClient, '$queryRaw' | '$executeRaw'> & {
  notificationDelivery: PrismaClient['notificationDelivery'];
};

/**
 * 購入者への知らせの永続化（P0-4）。
 *
 * ⚠️ **素の INSERT を書かない。** 同じ知らせが 2 度積まれると UNIQUE 違反の
 * 例外が飛び、**業務側のトランザクションごと巻き戻る**。決済は通っているのに
 * 注文が立たない、という最悪の形になる。`ON CONFLICT DO NOTHING` で受ける。
 *
 * ⚠️ **`claimBatch` を「探してから書く」実装にしない。** 複数のワーカーが
 * 同じ行を掴み、**同じ知らせが 2 通届く**。受け取った方には二重請求に見える。
 */
export class PrismaNotificationOutboxRepository implements NotificationOutboxPort {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * 送信待ちへ積む。**業務更新と同一トランザクションで呼ぶ。**
   *
   * @param executor トランザクションの中から呼ぶときは、そのクライアントを渡す。
   */
  async enqueue(
    input: NotificationEnqueueInput,
    executor?: Executor,
  ): Promise<NotificationEnqueueOutcome> {
    const db = executor ?? this.prisma;

    /*
      ⚠️ **`RETURNING` が空＝すでに積まれている。**
         そのときも例外にせず、既存の行を引き当てて「冪等成功」で返す。
    */
    const inserted = await db.$queryRaw<readonly { id: string }[]>(Prisma.sql`
      INSERT INTO "notification_deliveries" (
        "id", "event_type", "subject_type", "subject_id", "account_id",
        "rendered_subject", "rendered_body", "template_version",
        "status", "next_retry_at", "correlation_id", "created_at", "updated_at"
      ) VALUES (
        ${input.id}::uuid, ${input.eventType}, ${input.subjectType}, ${input.subjectId}::uuid,
        ${input.accountId}::uuid, ${input.renderedSubject}, ${input.renderedBody},
        ${input.templateVersion}, 'PENDING', ${input.now}, ${input.correlationId},
        ${input.now}, ${input.now}
      )
      ON CONFLICT ("event_type", "subject_type", "subject_id") DO NOTHING
      RETURNING "id"
    `);

    const created = inserted[0];
    if (created !== undefined) {
      return { kind: 'created', id: created.id };
    }

    const existing = await db.notificationDelivery.findUnique({
      where: {
        eventType_subjectType_subjectId: {
          eventType: input.eventType,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
        },
      },
      select: { id: true },
    });
    /*
      ⚠️ 直前に消えることは無い（削除の口が無い）。それでも `??` で受けるのは、
         ここで落ちると業務側のトランザクションを巻き戻すため。
    */
    return { kind: 'duplicate', id: existing?.id ?? input.id };
  }

  async claimBatch(input: {
    readonly limit: number;
    readonly now: Date;
  }): Promise<NotificationRecord[]> {
    const rows = await this.prisma.$queryRaw<readonly RawRow[]>(Prisma.sql`
      UPDATE "notification_deliveries"
         SET "status" = 'PROCESSING',
             "attempt_count" = "attempt_count" + 1,
             "updated_at" = ${input.now}
       WHERE "id" IN (
         SELECT "id"
           FROM "notification_deliveries"
          WHERE "status" = 'PENDING'
            AND "next_retry_at" <= ${input.now}
          ORDER BY "next_retry_at"
            FOR UPDATE SKIP LOCKED
          LIMIT ${input.limit}
       )
      RETURNING "id", "event_type", "subject_type", "subject_id", "account_id",
                "rendered_subject", "rendered_body", "template_version",
                "status", "attempt_count", "max_attempts", "correlation_id"
    `);
    return rows.map(fromRaw);
  }

  async markSent(input: {
    readonly id: string;
    readonly providerMessageId: string | null;
    readonly maskedRecipient: string;
    readonly recipientHash: string | null;
    readonly now: Date;
  }): Promise<boolean> {
    const updated = await this.prisma.notificationDelivery.updateMany({
      where: { id: input.id, status: 'PROCESSING' },
      data: {
        status: 'SENT',
        sentAt: input.now,
        providerMessageId: input.providerMessageId,
        // ⚠️ 平文ではなく伏せた表記。DB の CHECK が素の代入を弾く。
        maskedRecipient: input.maskedRecipient,
        recipientHash: input.recipientHash,
        updatedAt: input.now,
      },
    });
    return updated.count === 1;
  }

  async recordFailure(input: NotificationFailureInput): Promise<boolean> {
    const updated = await this.prisma.notificationDelivery.updateMany({
      where: { id: input.id, status: 'PROCESSING' },
      data: {
        status: input.status,
        nextRetryAt: input.nextRetryAt,
        lastErrorCode: input.errorCode,
        lastErrorMessage: input.errorMessage,
        updatedAt: input.now,
      },
    });
    return updated.count === 1;
  }

  async markSkipped(input: {
    readonly id: string;
    readonly reasonCode: string;
    readonly now: Date;
  }): Promise<boolean> {
    const updated = await this.prisma.notificationDelivery.updateMany({
      where: { id: input.id, status: 'PROCESSING' },
      data: {
        status: 'SKIPPED',
        skippedReasonCode: input.reasonCode,
        updatedAt: input.now,
      },
    });
    return updated.count === 1;
  }

  /**
   * `PROCESSING` のまま取り残された行を戻す。
   *
   * ⚠️ **これが無いと、送信中に落ちた行が永久に止まる。** 誰も拾わず、
   * 再試行もされず、「送ったつもり」のまま静かに残る。
   * ⚠️ 試行回数は戻さない。その 1 回は実際に送ろうとした。
   */
  async reclaimStale(input: { readonly staleBefore: Date; readonly now: Date }): Promise<number> {
    const updated = await this.prisma.notificationDelivery.updateMany({
      where: { status: 'PROCESSING', updatedAt: { lt: input.staleBefore } },
      data: { status: 'PENDING', nextRetryAt: input.now, updatedAt: input.now },
    });
    return updated.count;
  }

  /**
   * 手動で送り直す。⚠️ **本文は作り直さない。**
   *
   * 作り直すと、そのあいだに文面を直した場合、同じ知らせなのに
   * 1 通目と 2 通目で内容が変わる。
   */
  async requeue(input: { readonly id: string; readonly now: Date }): Promise<boolean> {
    const updated = await this.prisma.notificationDelivery.updateMany({
      // ⚠️ `PROCESSING` / `SENT` / `SKIPPED` は対象にしない。
      where: { id: input.id, status: { in: ['FAILED', 'DEAD'] } },
      data: {
        status: 'PENDING',
        attemptCount: 0,
        nextRetryAt: input.now,
        lastErrorCode: null,
        lastErrorMessage: null,
        updatedAt: input.now,
      },
    });
    return updated.count === 1;
  }
}

interface RawRow {
  readonly id: string;
  readonly event_type: string;
  readonly subject_type: string;
  readonly subject_id: string;
  readonly account_id: string;
  readonly rendered_subject: string;
  readonly rendered_body: string;
  readonly template_version: number;
  readonly status: string;
  readonly attempt_count: number;
  readonly max_attempts: number;
  readonly correlation_id: string | null;
}

function fromRaw(row: RawRow): NotificationRecord {
  return {
    id: row.id,
    eventType: row.event_type as NotificationEventType,
    subjectType: row.subject_type as NotificationSubjectType,
    subjectId: row.subject_id,
    accountId: row.account_id,
    renderedSubject: row.rendered_subject,
    renderedBody: row.rendered_body,
    templateVersion: row.template_version,
    status: row.status as NotificationStatus,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    correlationId: row.correlation_id,
  };
}
