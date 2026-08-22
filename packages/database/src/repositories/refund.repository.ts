import {
  clawbackBearerForRefundReason,
  TARGET_SITE_KEY,
  decideRevocation,
  refundStatusAfter,
  revocableEntitlementStatuses,
  type EntitlementStatus,
  type MintJobStatus,
  type RefundContext,
  type RefundInitiator,
  type RefundReason,
  type RefundRecordStatus,
  type RefundRecordView,
  type RefundRepository,
  type RefundSettlement,
  type RevocationPayloadConflict,
  type RevocationReviewItem,
  type SettleRefundCommand,
  type StartRefundCommand,
} from '@sengoku/domain';
import { Prisma } from '../../generated/client';
import type { PrismaClient } from '../../generated/client';
import { openOperationsReview } from './operations-review.repository';
import {
  enqueueWalletDeliveryIdempotent,
  supersedePendingGrantedEvents,
} from './wallet-delivery.repository';

/** トランザクションの中で使う Prisma。⚠️ 外の `prisma` を混ぜない。 */
type TransactionClient = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

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
        // ⚠️ 知らせの宛先の本人（P0-4）。アドレスそのものは持たない。
        accountId: true,
        orderNumber: true,
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
      accountId: order.accountId,
      orderNumber: order.orderNumber,
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
        /*
          誰が被るか（決定 2026-08-22）。
          ⚠️ **省略なら事由から決める。** 事業者発の返金（チャージバック）は
             `provider_initiated` で来るので、運営が被る側へ倒れる。
        */
        clawbackBearer: command.clawbackBearer ?? clawbackBearerForRefundReason(command.reason),
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
          revocationEventsCreated: 0,
          revocationEventsDuplicate: 0,
          supersededGrantedEvents: 0,
          revocationsNeedingReview: [],
          revocationPayloadConflicts: [],
          // ⚠️ 二度目は積まない。積むと同じ注文で 2 件流れる。
          agencyRefundEventCreated: false,
        };
      }

      /*
        2. 決済行の返金累計。
        ⚠️ **積み増しではなく置く。** 事業者は累計で持つので、差分で
           積むと知らせが前後して届いたときに合わなくなる。
      */
      const refund = await tx.refund.findUniqueOrThrow({
        where: { id: command.refundId },
        select: { paymentId: true, settledAt: true },
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
        4. 受取権と、相手への取消の知らせ。

        ⚠️ **受け取った事実は消さない。** `claimed_at` / `claimed_by_*` /
           配送記録はそのまま残し、`status` だけを `revoked` へ進める
           （`UD-104` 追補・2026-08-20 決定）。

        ⚠️ **`revoked` へ進めるだけでは足りない。** 相手が知っている受取権は、
           取消を伝えないと**返金したのに作品が残ったまま**になる。
           知らせの作成も**このトランザクションの中で**行う。
      */
      const revocation = await revokeEntitlements(tx, command, refund.settledAt ?? command.now);

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

      /*
        7. 代理店へ渡す出来事（`UD-1003` の手前）。

        ⚠️ **全額返ったときだけ積む。** 一部返金は「返金された注文」では
           ない。積むと、受け取る側が売上を丸ごと取り消す判断をしうる。

        ⚠️ **いま送る先は無い。** 行が溜まるだけである。それでも
           **起きた時点で積む**——あとから「いつ返金になったか」を
           `refunds` から組み直すことはできても、**そのとき積むはずだった
           出来事**は作り直せない。`order.paid` と対に揃えておく。

        ⚠️ **重複は握りつぶす。** `ON CONFLICT DO NOTHING`（部分 UNIQUE
           索引）。ここで例外を出すと、**決済事業者へ届いている返金の
           記録ごと巻き戻る**——出来事を 1 件取りこぼすより悪い。
      */
      let agencyRefundEventCreated = false;
      if (command.outboxEventId !== null && refundStatus === 'refunded') {
        const appended = await tx.outboxEvent.createMany({
          data: [
            {
              id: command.outboxEventId,
              eventName: 'order.refunded',
              aggregateType: 'order',
              aggregateId: command.orderId,
              // ⚠️ 個人情報も金額も入れない。読む側は注文IDから引く（`order.paid` と同じ）。
              payload: { orderId: command.orderId },
              occurredAt: refund.settledAt ?? command.now,
            },
          ],
          skipDuplicates: true,
        });
        agencyRefundEventCreated = appended.count === 1;
      }

      return {
        alreadySettled: false,
        refundStatus,
        amountRefunded: command.amountRefundedTotal,
        revokedEntitlements: revocation.revoked,
        cancelledMintJobs,
        annotatedMintJobs,
        restoredSupply,
        revocationEventsCreated: revocation.created,
        revocationEventsDuplicate: revocation.duplicate,
        supersededGrantedEvents: revocation.superseded,
        revocationsNeedingReview: revocation.needsReview,
        revocationPayloadConflicts: revocation.conflicts,
        agencyRefundEventCreated,
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

/** 取消の 1 巡ぶんの結果。⚠️ 本文や個人情報を含めない（監査へ出るため）。 */
interface RevocationSummary {
  readonly revoked: number;
  readonly created: number;
  readonly duplicate: number;
  readonly superseded: number;
  readonly needsReview: readonly RevocationReviewItem[];
  readonly conflicts: readonly RevocationPayloadConflict[];
}

const NO_REVOCATION: RevocationSummary = {
  revoked: 0,
  created: 0,
  duplicate: 0,
  superseded: 0,
  needsReview: [],
  conflicts: [],
};

interface RevocableRow {
  readonly id: string;
  readonly status: string;
  readonly order_line_id: string;
  readonly artwork_id: string;
  readonly claimed_by_common_user_id: string | null;
}

/**
 * 受取権を取り消し、相手が知っているものへ取消の知らせを積む。
 *
 * ⚠️ **すべて 1 つのトランザクションで行う。** 取り消してから別呼び出しで
 * 知らせを作ると、そのあいだに落ちた分が「取り消したのに相手へ永遠に
 * 伝わらない」まま、誰にも気づかれず残る。
 *
 * ⚠️ **例外で返金を巻き戻さない。** 知らせが作れなかった・宛先が決まらない
 * といった事情で投げると、決済事業者へ届いている返金の記録だけが消える。
 * 判断できないことは**運用確認へ積んで先へ進む**。
 *
 * @param occurredAt 返金の `settled_at`。⚠️ **現在時刻を渡さない**——
 *   呼び出しのたびに変わると本文が変わり、正常な重複が
 *   「本文の食い違い」として検知される。
 */
async function revokeEntitlements(
  tx: TransactionClient,
  command: SettleRefundCommand,
  occurredAt: Date,
): Promise<RevocationSummary> {
  if (!command.revokeEntitlement) {
    return NO_REVOCATION;
  }

  const statuses = revocableEntitlementStatuses(command.revokeClaimedEntitlements);
  /*
    ⚠️ **件数だけ数える `updateMany` にしない。** どの受取権を取り消したのかが
       分からないと、相手へ何を伝えればよいのかも分からない。
    ⚠️ **`FOR UPDATE` で掴む。** 掴まずに読むと、同じ注文への並行した返金が
       両方とも「取り消せる」と判断しうる。
    ⚠️ `status` は enum 型なので、文字列の引数と比べるために `::text` を挟む。
  */
  const targets = await tx.$queryRaw<readonly RevocableRow[]>(Prisma.sql`
    SELECT "id", "status"::text AS "status", "order_line_id", "artwork_id",
           "claimed_by_common_user_id"
      FROM "entitlements"
     WHERE "order_id" = ${command.orderId}::uuid
       AND "status"::text IN (${Prisma.join([...statuses])})
     ORDER BY "serial_no"
       FOR UPDATE
  `);

  let revoked = 0;
  let created = 0;
  let duplicate = 0;
  let superseded = 0;
  const needsReview: RevocationReviewItem[] = [];
  const conflicts: RevocationPayloadConflict[] = [];

  for (const row of targets) {
    // ⚠️ 条件付き更新。掴んではいるが、状態を確かめてから進める。
    const updated = await tx.entitlement.updateMany({
      where: { id: row.id, status: row.status as EntitlementStatus },
      data: { status: 'revoked', updatedAt: command.now },
    });
    if (updated.count !== 1) {
      continue;
    }
    revoked += 1;

    /*
      ⚠️ **知らせを作らない設定なら、付与イベントにも触らない。**
         付与を止めたのに取消も作らないと、相手はこの受取権を
         永遠に知らないまま、こちらの記録とも突き合わせられなくなる。
         生成を有効にしたあと、補完（reconciliation）が両方まとめて行う。
    */
    const plan = command.planRevocation;
    if (plan === null) {
      continue;
    }

    /*
      相手が知っているか。⚠️ **配送済みかどうかでは判定しない。**
      送信待ち・失敗・打ち切りのいずれでも、相手は現在または将来この
      受取権を知りうる。知る側にだけ取消が届かない状態を作らない。
    */
    const granted = await tx.walletDeliveryOutbox.findFirst({
      where: { entitlementId: row.id, eventType: 'entitlement.granted' },
      orderBy: [{ createdAt: 'asc' }],
      select: { payload: true, correlationId: true },
    });

    const decision = decideRevocation({
      entitlementId: row.id,
      orderId: command.orderId,
      hasGrantedEvent: granted !== null,
      // ⚠️ **相手へ実際に伝えた値**を正とする。列を先に見ると、万一
      //    食い違っていた場合に別人の Holding を消しにいく。
      grantedCommonUserId: granted === null ? null : commonUserIdOf(granted.payload),
      claimedCommonUserId: row.claimed_by_common_user_id,
      grantedCorrelationId: granted?.correlationId ?? null,
    });

    if (decision.kind === 'revoke_only') {
      continue;
    }

    if (decision.kind === 'needs_review') {
      needsReview.push({ entitlementId: row.id, reason: decision.reason });
      await openOperationsReview(tx, {
        subjectType: 'entitlement',
        subjectId: row.id,
        orderId: command.orderId,
        reasonCode: 'wallet_revocation_recipient_unresolved',
        // ⚠️ 個人情報を入れない。識別子と、決められなかった理由まで。
        detail: `付与は送っているが宛先の共通顧客IDを特定できないため、取消を送っていません（refundId=${command.refundId}）。`,
        now: command.now,
      });
      superseded += await supersedePendingGrantedEvents(tx, {
        entitlementId: row.id,
        now: command.now,
      });
      continue;
    }

    const built = plan({
      entitlementId: row.id,
      orderId: command.orderId,
      orderLineId: row.order_line_id,
      artworkId: row.artwork_id,
      eventId: decision.eventId,
      commonUserId: decision.commonUserId,
      correlationId: decision.correlationId,
      occurredAt,
    });

    const outcome = await enqueueWalletDeliveryIdempotent(tx, {
      eventId: built.eventId,
      eventType: 'entitlement.revoked',
      entitlementId: row.id,
      targetSiteKey: TARGET_SITE_KEY,
      payload: built.payload,
      payloadHash: built.payloadHash,
      correlationId: built.correlationId,
      now: command.now,
    });

    if (outcome.kind === 'created') {
      created += 1;
    } else if (outcome.kind === 'duplicate') {
      duplicate += 1;
    } else {
      /*
        ⚠️ **無言で成功にしない。** 冪等キーが同じで中身が違う以上、
           どちらが相手に保存されたのか、こちらからは分からない。
        ⚠️ **例外にもしない。** 返金済みの事実を巻き戻さない。
      */
      conflicts.push({
        entitlementId: row.id,
        eventId: outcome.eventId,
        expectedPayloadHash: outcome.expectedPayloadHash,
        actualPayloadHash: outcome.actualPayloadHash,
      });
      await openOperationsReview(tx, {
        subjectType: 'entitlement',
        subjectId: row.id,
        orderId: command.orderId,
        reasonCode: 'wallet_revocation_payload_conflict',
        detail: `同じイベントID（${outcome.eventId}）で本文が食い違いました（期待 ${outcome.expectedPayloadHash} / 実際 ${outcome.actualPayloadHash}）。`,
        now: command.now,
      });
    }

    /*
      まだ送っていない付与イベントを止める。
      ⚠️ **これをしないと、取り消したはずの作品があとから相手側に現れる。**
      ⚠️ `PROCESSING` と `DELIVERED` は触らない（相手の Tombstone に委ねる）。
    */
    superseded += await supersedePendingGrantedEvents(tx, {
      entitlementId: row.id,
      now: command.now,
    });
  }

  return { revoked, created, duplicate, superseded, needsReview, conflicts };
}

/**
 * 付与イベントの本文から共通顧客IDを取り出す。
 *
 * ⚠️ **読めなければ `null`。投げない。** 本文が壊れていることを理由に
 * 返金を巻き戻さない。宛先が決まらないことは呼び出し元が扱う。
 */
function commonUserIdOf(payload: string): string | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const value = (parsed as { common_user_id?: unknown }).common_user_id;
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
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
