import type {
  WalletDeliveryEnqueueInput,
  WalletDeliveryEnqueueOutcome,
  WalletDeliveryEventType,
  WalletDeliveryFailureInput,
  WalletDeliveryOutboxPort,
  WalletDeliveryOutboxStatus,
  WalletDeliveryRecord,
} from '@sengoku/domain';
import { Prisma } from '../../generated/client';
import type { PrismaClient } from '../../generated/client';

/**
 * OVEW Wallet への配送待ち行列の永続化。
 *
 * ⚠️ **`claimBatch` は「探してから書く」実装にしない。**
 * 送る対象を SELECT してから UPDATE すると、複数のワーカーが
 * 同じ行を掴み、**同じイベントを二重に送る**。相手の冪等性だけが
 * 最後の砦になり、こちらは二重送信していることに気づけない。
 * `FOR UPDATE SKIP LOCKED` で掴み、掴めた行だけを返す。
 */
export class PrismaWalletDeliveryOutboxRepository implements WalletDeliveryOutboxPort {
  constructor(private readonly prisma: PrismaClient) {}

  async enqueue(input: WalletDeliveryEnqueueInput): Promise<WalletDeliveryRecord> {
    const row = await this.prisma.walletDeliveryOutbox.create({
      data: {
        eventId: input.eventId,
        eventType: input.eventType,
        entitlementId: input.entitlementId,
        targetSiteKey: input.targetSiteKey,
        payload: input.payload,
        payloadHash: input.payloadHash,
        correlationId: input.correlationId,
        // 作った直後から送ってよい。
        nextRetryAt: input.now,
        createdAt: input.now,
        updatedAt: input.now,
      },
    });
    return toRecord(row);
  }

  /**
   * 送る対象を排他的に掴み、`PROCESSING` へ進める。
   *
   * 取得と状態遷移を 1 文にまとめてある。分けると、掴んだあと
   * 遷移する前に落ちた行が `PENDING` のまま残り、別のワーカーが同じものを送る。
   */
  async claimBatch(input: {
    readonly limit: number;
    readonly now: Date;
    readonly eventTypes: readonly WalletDeliveryEventType[];
  }): Promise<WalletDeliveryRecord[]> {
    /*
      ⚠️ **空なら 1 件も掴まない。**
         「指定が無い＝全部」にすると、フラグの読み落とし 1 つで
         全種別の配送が始まる。安全側は「送らない」。
    */
    if (input.eventTypes.length === 0) {
      return [];
    }
    const rows = await this.prisma.$queryRaw<readonly RawRow[]>(Prisma.sql`
      UPDATE "wallet_delivery_outbox"
         SET "status" = 'PROCESSING',
             "attempt_count" = "attempt_count" + 1,
             "updated_at" = ${input.now}
       WHERE "id" IN (
         SELECT "id"
           FROM "wallet_delivery_outbox"
          WHERE "status" = 'PENDING'
            AND "next_retry_at" <= ${input.now}
            AND "event_type" IN (${Prisma.join(input.eventTypes)})
          ORDER BY "next_retry_at"
            FOR UPDATE SKIP LOCKED
          LIMIT ${input.limit}
       )
      RETURNING "id", "event_id", "event_type", "entitlement_id", "target_site_key",
                "payload", "payload_hash", "status", "attempt_count", "max_attempts",
                "correlation_id"
    `);
    return rows.map(fromRaw);
  }

  /**
   * 配送待ちの行を**冪等に**作る。
   *
   * ⚠️ **素の INSERT にしない。** UNIQUE 違反の例外はトランザクション全体を
   * 巻き戻す。この処理は返金のトランザクションの中から呼ばれるため、
   * 重複した Webhook 1 通で**返金の記録ごと消える**。返金は決済事業者へ
   * 既に届いているので、金額の食い違いのうちいちばん見つけにくい形になる。
   *
   * ⚠️ **本文が違うのに「入っていたからよし」としない。** 冪等キーが同じで
   * 中身が違う以上、どちらが相手に保存されたのかこちらからは分からない。
   * 例外にはせず、呼び出し元が運用確認へ回せるように結果で返す。
   */
  enqueueIdempotent(input: WalletDeliveryEnqueueInput): Promise<WalletDeliveryEnqueueOutcome> {
    return enqueueWalletDeliveryIdempotent(this.prisma, input);
  }

  /**
   * まだ送っていない付与イベントを「取消に追い越された」状態にする。
   *
   * ⚠️ **`PROCESSING` を触らない。** いま送っている最中か、送信直後に
   * 落ちた可能性がある。届いたかどうかが分からない行を止めても、
   * 相手側の状態は変えられない。相手の Tombstone 処理に委ねる。
   *
   * ⚠️ **`DELIVERED` も触らない。** すでに届いており、打ち消すのは
   * 取消イベントの仕事である。
   *
   * ⚠️ **行を消さない。** 「送ろうとしていた」事実は残す。
   */
  supersedePendingGranted(input: {
    readonly entitlementId: string;
    readonly now: Date;
  }): Promise<number> {
    return supersedePendingGrantedEvents(this.prisma, input);
  }

  /**
   * 配送成功を記録する。
   *
   * ⚠️ **受取権側の更新と同一トランザクションで行う。**
   * 行列だけ `DELIVERED` にして受取権を放置すると、利用者には
   * 「お届け中」のまま見え、しかも再送の対象からも外れる。
   *
   * ⚠️ **取り消しイベントで受取権を `delivered` にしない。**
   * 「取り消しを伝えられた」ことと「受け取れた」ことは別の事実。
   * 混ぜると、取り消した受取権が配送済みとして残る。
   */
  async markDelivered(input: { readonly id: string; readonly now: Date }): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.walletDeliveryOutbox.updateMany({
        where: { id: input.id, status: 'PROCESSING' },
        data: { status: 'DELIVERED', deliveredAt: input.now, updatedAt: input.now },
      });
      if (updated.count !== 1) {
        return false;
      }

      const row = await tx.walletDeliveryOutbox.findUnique({
        where: { id: input.id },
        select: { eventType: true, entitlementId: true },
      });
      if (row?.eventType === 'entitlement.granted') {
        // `status = 'claimed'` を条件に含める。取り消された受取権を
        // 配送済みへ進めると、DB の CHECK 制約と食い違う。
        await tx.entitlement.updateMany({
          where: { id: row.entitlementId, status: 'claimed' },
          data: {
            walletDeliveryStatus: 'delivered',
            walletDeliveredAt: input.now,
            updatedAt: input.now,
          },
        });
      }
      return true;
    });
  }

  /** 失敗を記録する。次の状態と再試行時刻はドメイン判定が決める。 */
  async recordFailure(input: WalletDeliveryFailureInput): Promise<boolean> {
    const updated = await this.prisma.walletDeliveryOutbox.updateMany({
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

  /**
   * 手動再送（§20）。
   *
   * ⚠️ **`event_id` と `payload` は触らない。**
   * 作り直すと相手の冪等キーが変わり、同じ受取権の Holding が 2 つできる。
   *
   * ⚠️ **`PROCESSING` を戻さない。**
   * その行は送信中か、送信直後に落ちた可能性がある。届いたかどうかが
   * 分からない状態で押し直すと、相手の冪等性だけが最後の砦になる。
   *
   * 試行回数は 0 に戻す。原因を直したうえでの再送なので、
   * 直前の失敗回数を引き継ぐと一度で `DEAD` に戻る。
   * 「何回押し直したか」は監査ログ側に残す。
   */
  async requeue(input: { readonly id: string; readonly now: Date }): Promise<boolean> {
    const updated = await this.prisma.walletDeliveryOutbox.updateMany({
      where: { id: input.id, status: { in: ['FAILED', 'DEAD'] } },
      data: {
        status: 'PENDING',
        attemptCount: 0,
        nextRetryAt: input.now,
        updatedAt: input.now,
      },
    });
    return updated.count === 1;
  }

  /**
   * `PROCESSING` のまま取り残された行を `PENDING` へ戻す。
   *
   * ⚠️ 試行回数は戻さない。その 1 回は実際に送ろうとしたため、
   * なかったことにすると上限が意味を失う。
   */
  async reclaimStale(input: { readonly staleBefore: Date; readonly now: Date }): Promise<number> {
    const updated = await this.prisma.walletDeliveryOutbox.updateMany({
      where: { status: 'PROCESSING', updatedAt: { lt: input.staleBefore } },
      data: { status: 'PENDING', nextRetryAt: input.now, updatedAt: input.now },
    });
    return updated.count;
  }

  async findByEventId(eventId: string): Promise<WalletDeliveryRecord | null> {
    const row = await this.prisma.walletDeliveryOutbox.findUnique({ where: { eventId } });
    return row === null ? null : toRecord(row);
  }
}

interface RawRow {
  readonly id: string;
  readonly event_id: string;
  readonly event_type: string;
  readonly entitlement_id: string;
  readonly target_site_key: string;
  readonly payload: string;
  readonly payload_hash: string;
  readonly status: string;
  readonly attempt_count: number;
  readonly max_attempts: number;
  readonly correlation_id: string;
}

function fromRaw(row: RawRow): WalletDeliveryRecord {
  return {
    id: row.id,
    eventId: row.event_id,
    eventType: row.event_type as WalletDeliveryEventType,
    entitlementId: row.entitlement_id,
    targetSiteKey: row.target_site_key,
    payload: row.payload,
    payloadHash: row.payload_hash,
    status: row.status as WalletDeliveryOutboxStatus,
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    correlationId: row.correlation_id,
  };
}

/**
 * トランザクションクライアントでも通る最小の口。
 *
 * ⚠️ **`PrismaClient` そのものを要求しない。** 返金のトランザクションの
 * 中から同じ処理を呼べるようにするため、必要なものだけを型で示す。
 */
export type WalletOutboxExecutor = Pick<PrismaClient, '$executeRaw' | 'walletDeliveryOutbox'>;

/**
 * 配送待ちの行を**冪等に**作る。
 *
 * ⚠️ **素の INSERT にしない。** UNIQUE 違反の例外はトランザクション全体を
 * 巻き戻す。この処理は返金のトランザクションの中からも呼ばれるため、
 * 重複した Webhook 1 通で**返金の記録ごと消える**。返金は決済事業者へ
 * 既に届いているので、金額の食い違いのうちいちばん見つけにくい形になる。
 *
 * ⚠️ **本文が違うのに「入っていたからよし」としない。** 冪等キーが同じで
 * 中身が違う以上、どちらが相手に保存されたのかこちらからは分からない。
 * 例外にはせず、呼び出し元が運用確認へ回せるように結果で返す。
 *
 * ⚠️ **通常の生成と取りこぼしの補完で、この 1 つを共有する。** 2 つ書くと、
 * 片方だけが冪等という状態がいつか生まれる。
 */
export async function enqueueWalletDeliveryIdempotent(
  db: WalletOutboxExecutor,
  input: WalletDeliveryEnqueueInput,
): Promise<WalletDeliveryEnqueueOutcome> {
  const inserted = await db.$executeRaw(Prisma.sql`
    INSERT INTO "wallet_delivery_outbox"
      ("id", "event_id", "event_type", "entitlement_id", "target_site_key",
       "payload", "payload_hash", "correlation_id",
       "next_retry_at", "created_at", "updated_at")
    VALUES
      (gen_random_uuid(), ${input.eventId}, ${input.eventType}, ${input.entitlementId}::uuid,
       ${input.targetSiteKey}, ${input.payload}, ${input.payloadHash}, ${input.correlationId},
       ${input.now}, ${input.now}, ${input.now})
    ON CONFLICT ("event_id") DO NOTHING
  `);

  const row = await db.walletDeliveryOutbox.findUnique({ where: { eventId: input.eventId } });
  if (row === null) {
    // 入れた直後に誰かが消した場合しかここへ来ない。行を消す口はどこにも
    // 無いので、起きたら設計の前提が壊れている。黙って進めない。
    throw new Error(`wallet delivery outbox row vanished: ${input.eventId}`);
  }

  if (inserted === 1) {
    return { kind: 'created', record: toRecord(row) };
  }
  if (row.payloadHash === input.payloadHash) {
    return { kind: 'duplicate', record: toRecord(row) };
  }
  return {
    kind: 'payload_conflict',
    eventId: input.eventId,
    expectedPayloadHash: input.payloadHash,
    actualPayloadHash: row.payloadHash,
  };
}

/**
 * まだ送っていない付与イベントを「取消に追い越された」状態にする。
 *
 * ⚠️ **`PROCESSING` を触らない。** いま送っている最中か、送信直後に落ちた
 * 可能性がある。届いたかどうかが分からない行を止めても、相手側の状態は
 * 変えられない。相手の Tombstone 処理に委ねる。
 *
 * ⚠️ **`DELIVERED` も触らない。** すでに届いており、打ち消すのは取消
 * イベントの仕事である。
 *
 * ⚠️ **行を消さない。** 「送ろうとしていた」事実は残す。
 */
export async function supersedePendingGrantedEvents(
  db: Pick<PrismaClient, 'walletDeliveryOutbox'>,
  input: { readonly entitlementId: string; readonly now: Date },
): Promise<number> {
  const updated = await db.walletDeliveryOutbox.updateMany({
    where: {
      entitlementId: input.entitlementId,
      eventType: 'entitlement.granted',
      status: { in: ['PENDING', 'FAILED', 'DEAD'] },
    },
    data: { status: 'SUPERSEDED', updatedAt: input.now },
  });
  return updated.count;
}

function toRecord(row: {
  id: string;
  eventId: string;
  eventType: string;
  entitlementId: string;
  targetSiteKey: string;
  payload: string;
  payloadHash: string;
  status: string;
  attemptCount: number;
  maxAttempts: number;
  correlationId: string;
}): WalletDeliveryRecord {
  return {
    id: row.id,
    eventId: row.eventId,
    eventType: row.eventType as WalletDeliveryEventType,
    entitlementId: row.entitlementId,
    targetSiteKey: row.targetSiteKey,
    payload: row.payload,
    payloadHash: row.payloadHash,
    status: row.status as WalletDeliveryOutboxStatus,
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    correlationId: row.correlationId,
  };
}
