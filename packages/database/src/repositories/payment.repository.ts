import {
  type ConfirmPaymentCommand,
  type PaymentAttemptView,
  type PaymentRepository,
  type RecordCheckoutSessionCommand,
  type RecordWebhookCommand,
  type WebhookClaim,
  type WebhookReceiptRecord,
} from '@sengoku/domain';
import { Prisma, type PrismaClient } from '../../generated/client';

/**
 * 決済リポジトリの Prisma 実装（決済 Phase P2）。
 *
 * ⚠️ **在庫のカウンタをここで動かさない**（決定 A）。決済が成功しても
 * `artworks.reserved_count` は減らさず、`issued_count` も増やさない。
 * 動かしてよいのは受取権を作るのと同じトランザクション（Phase P3）だけ。
 * ここで減らすと、受取権を作る前のわずかな間だけ販売枠が復活し、
 * その隙に他の人が買うと、売れた注文の発行が上限で弾かれる。
 *
 * ⚠️ **Stripe API をこのクラスから呼ばない。** 外部への往復を
 * トランザクションの中へ入れると、その間ずっと行ロックを握る。
 */
export class PrismaPaymentRepository implements PaymentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * 受け取った知らせを記録し、処理してよいかを返す。
   *
   * ⚠️ **「探して無ければ書く」にしない。** 同時に届いた同じ知らせを
   * 2 本とも通してしまう。`(provider, event_id)` の UNIQUE で決める。
   */
  async claimWebhookEvent(command: RecordWebhookCommand): Promise<WebhookClaim> {
    try {
      await this.prisma.webhookEvent.create({
        data: {
          id: command.id,
          provider: command.provider,
          eventId: command.eventId,
          eventType: command.eventType,
          apiVersion: command.apiVersion,
          livemode: command.livemode,
          // ⚠️ 本文の全体は保存しない。残すのは digest だけ。
          payloadDigest: command.payloadDigest,
          orderId: command.orderId,
          status: 'received',
          attemptCount: 1,
          receivedAt: command.now,
        },
      });
      return { kind: 'claimed' };
    } catch (error) {
      if (isUniqueViolation(error)) {
        // すでに受け取っている。⚠️ 試行回数だけ進めて、処理はしない。
        await this.prisma.webhookEvent.updateMany({
          where: { provider: command.provider, eventId: command.eventId },
          data: { attemptCount: { increment: 1 } },
        });
        return { kind: 'duplicate' };
      }
      throw error;
    }
  }

  async markWebhookProcessed(input: {
    readonly provider: string;
    readonly eventId: string;
    readonly status: 'processed' | 'ignored' | 'failed';
    readonly orderId: string | null;
    readonly paymentId: string | null;
    readonly errorCode: string | null;
    readonly now: Date;
  }): Promise<void> {
    await this.prisma.webhookEvent.updateMany({
      where: { provider: input.provider, eventId: input.eventId },
      data: {
        status: input.status,
        // CHECK 制約が「processed なら時刻が入る」を守っている。
        processedAt: input.now,
        orderId: input.orderId,
        paymentId: input.paymentId,
        lastErrorCode: input.errorCode,
      },
    });
  }

  async findLastWebhookReceivedAt(provider: string): Promise<Date | null> {
    const row = await this.prisma.webhookEvent.findFirst({
      where: { provider },
      orderBy: { receivedAt: 'desc' },
      // ⚠️ 時刻だけを取り出す。本文も署名も読まない。
      select: { receivedAt: true },
    });
    return row?.receivedAt ?? null;
  }

  async listWebhookReceipts(orderId: string): Promise<readonly WebhookReceiptRecord[]> {
    const rows = await this.prisma.webhookEvent.findMany({
      where: { orderId },
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      // ⚠️ 本文は保存していないので、そもそも返せるものが無い。
      select: {
        eventType: true,
        status: true,
        livemode: true,
        apiVersion: true,
        attemptCount: true,
        receivedAt: true,
        processedAt: true,
        lastErrorCode: true,
      },
      take: 50,
    });
    return rows.map((row) => ({
      eventType: row.eventType,
      status: row.status,
      livemode: row.livemode,
      apiVersion: row.apiVersion,
      attemptCount: row.attemptCount,
      receivedAt: row.receivedAt,
      processedAt: row.processedAt,
      lastErrorCode: row.lastErrorCode,
    }));
  }

  /**
   * その世代で処理した決済の件数（`UD-118`）。
   *
   * ⚠️ **件数だけ。** 金額は返さない。世代の画面に要るのは
   * 「まだ使われているか」の判断材料まで。
   */
  countByCredential(credentialId: string): Promise<number> {
    return this.prisma.payment.count({ where: { credentialId } });
  }

  async listAttempts(orderId: string): Promise<readonly PaymentAttemptView[]> {
    const rows = await this.prisma.payment.findMany({
      where: { orderId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return rows.map(toAttempt);
  }

  /**
   * 支払い口を記録する。
   *
   * ⚠️ **同じ冪等キーの行が既にあれば、それを返す。** 事業者側は
   * 冪等キーで同じ口を返すので、こちらだけ 2 行作ると
   * 「1 つの口に 2 つの記録」ができ、どちらを見ればよいか分からなくなる。
   */
  async recordCheckoutSession(command: RecordCheckoutSessionCommand): Promise<PaymentAttemptView> {
    const existing = await this.prisma.payment.findFirst({
      where: { provider: command.provider, providerIdempotencyKey: command.idempotencyKey },
    });
    if (existing !== null) {
      return toAttempt(existing);
    }

    try {
      const created = await this.prisma.payment.create({
        data: {
          id: command.paymentId,
          orderId: command.orderId,
          provider: command.provider,
          providerSessionRef: command.sessionRef,
          providerPaymentRef: command.paymentRef,
          providerIdempotencyKey: command.idempotencyKey,
          status: 'pending',
          amount: command.amount,
          currency: command.currency,
          checkoutUrl: command.url,
          expiresAt: command.expiresAt,
          createdAt: command.now,
          updatedAt: command.now,
        },
      });

      // ⚠️ 注文を `checkout_created` へ進めるのは、口ができてから。
      //    先に進めると、口の作成に失敗した注文が進んだままになる。
      await this.prisma.order.updateMany({
        where: { id: command.orderId, status: { in: ['pending', 'checkout_created'] } },
        data: { status: 'checkout_created', paymentStatus: 'pending', updatedAt: command.now },
      });

      return toAttempt(created);
    } catch (error) {
      if (isUniqueViolation(error)) {
        // 同時に走ったもう 1 本が先に作った。そちらを返す。
        const row = await this.prisma.payment.findFirstOrThrow({
          where: { provider: command.provider, providerIdempotencyKey: command.idempotencyKey },
        });
        return toAttempt(row);
      }
      throw error;
    }
  }

  /**
   * 決済の成功を 1 トランザクションで確定する（指示書 §7）。
   *
   * ⚠️ **すべて条件付き更新にする。** 再送・順序の逆転・同じ支払いに
   * 対する複数のイベントが来ても、1 回しか進まないようにするため。
   * 「読んでから書く」にすると、2 本が同じ状態を読んで両方書く。
   */
  async confirmPayment(command: ConfirmPaymentCommand): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      // 1. 決済行を成功へ。⚠️ `pending` のときだけ。
      const target = await tx.payment.findFirst({
        where: {
          orderId: command.orderId,
          provider: command.provider,
          ...(command.sessionRef === null ? {} : { providerSessionRef: command.sessionRef }),
        },
        orderBy: [{ createdAt: 'desc' }],
      });
      if (target === null) {
        return false;
      }

      const paymentUpdated = await tx.payment.updateMany({
        where: { id: target.id, status: 'pending' },
        data: {
          status: 'succeeded',
          paidAt: command.paidAt,
          providerPaymentRef: command.paymentRef ?? target.providerPaymentRef,
          providerChargeRef: command.chargeRef ?? target.providerChargeRef,
          updatedAt: command.now,
        },
      });
      if (paymentUpdated.count !== 1) {
        // すでに成功しているか、失敗で終わっている。二重に確定しない。
        return false;
      }

      // 2. 注文を支払い済みへ。⚠️ まだ支払われていない状態のときだけ。
      await tx.order.updateMany({
        where: { id: command.orderId, status: { in: ['pending', 'checkout_created'] } },
        data: {
          status: 'paid',
          paymentStatus: 'succeeded',
          paidAt: command.paidAt,
          updatedAt: command.now,
        },
      });

      /*
        3. 仮引当を「使った」印にする。
        ⚠️ **在庫のカウンタは動かさない**（決定 A）。`consumed` になっても
           `reserved_count` はそのまま。受取権を作るまで、この枠は
           `reserved_count` 側で押さえ続ける。
      */
      await tx.inventoryReservation.updateMany({
        where: { orderId: command.orderId, status: 'reserved' },
        data: { status: 'consumed', consumedAt: command.paidAt, updatedAt: command.now },
      });

      /*
        4. 次の工程へ渡す出来事を 1 件だけ作る。
        ⚠️ **同じトランザクションの中で作る。** 別にすると、決済は
           確定したのに出来事が無い注文ができ、受取権が永久に発行されない。
        ⚠️ **`aggregate_id` は注文ID。** 同じ注文で 2 件作らないことは、
           上の条件付き更新（1 回しか通らない）が保証している。
      */
      await tx.outboxEvent.create({
        data: {
          id: command.outboxEventId,
          eventName: 'order.paid',
          aggregateType: 'order',
          aggregateId: command.orderId,
          // ⚠️ 個人情報も事業者の識別子も入れない。読む側は注文IDから引く。
          payload: { orderId: command.orderId },
          occurredAt: command.paidAt,
        },
      });

      return true;
    });
  }

  /**
   * 決済の失敗を記録する。
   *
   * ⚠️ **注文は `checkout_created` のまま**（決定 B）。お取り置きの
   * 期限内なら、もう一度払える。ここで注文を閉じると、在庫を押さえた
   * ままの人が二度と払えなくなる。
   */
  async recordFailure(input: {
    readonly orderId: string;
    readonly sessionRef: string | null;
    readonly paymentRef: string | null;
    readonly failureCode: string;
    readonly now: Date;
  }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.payment.updateMany({
        where: {
          orderId: input.orderId,
          status: 'pending',
          ...(input.sessionRef === null ? {} : { providerSessionRef: input.sessionRef }),
        },
        data: { status: 'failed', failureCode: input.failureCode, updatedAt: input.now },
      });
      // ⚠️ 注文の状態は動かさない。決済の状態だけを戻す。
      await tx.order.updateMany({
        where: { id: input.orderId, status: 'checkout_created', paymentStatus: 'pending' },
        data: { paymentStatus: 'failed', updatedAt: input.now },
      });
    });
  }

  /**
   * 支払い口の期限切れを記録し、注文と仮引当を閉じる。
   *
   * ⚠️ **既存の解放ジョブと二重に解放しない**（指示書 §8）。
   * 仮引当を条件付き更新で掴んでから在庫を戻す。掴めなければ
   * もう片方が処理済みなので、何もしない。
   */
  async expireCheckout(input: {
    readonly orderId: string;
    readonly sessionRef: string | null;
    readonly now: Date;
  }): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.$queryRaw<
        readonly { id: string; artwork_id: string; quantity: number }[]
      >(
        Prisma.sql`
          UPDATE "inventory_reservations"
             SET "status" = 'released',
                 "released_at" = ${input.now},
                 "updated_at" = ${input.now}
           WHERE "order_id" = ${input.orderId}::uuid
             AND "status" = 'reserved'
          RETURNING "id", "artwork_id", "quantity"
        `,
      );

      await tx.payment.updateMany({
        where: {
          orderId: input.orderId,
          status: 'pending',
          ...(input.sessionRef === null ? {} : { providerSessionRef: input.sessionRef }),
        },
        data: { status: 'cancelled', updatedAt: input.now },
      });

      if (claimed.length === 0) {
        // 解放ジョブが先に処理していた。在庫を二重に戻さない。
        return false;
      }

      for (const row of claimed) {
        await tx.artwork.update({
          where: { id: row.artwork_id },
          data: { reservedCount: { decrement: row.quantity }, updatedAt: input.now },
        });
      }

      await tx.order.updateMany({
        where: { id: input.orderId, status: { in: ['pending', 'checkout_created'] } },
        data: { status: 'expired', paymentStatus: 'cancelled', updatedAt: input.now },
      });

      return true;
    });
  }
}

type PaymentRow = Awaited<ReturnType<PrismaClient['payment']['findFirstOrThrow']>>;

/**
 * DB の決済状態を、ドメインの状態へ写す。
 *
 * ⚠️ **キャストで済ませない。** DB 側には `partially_refunded` があり、
 * ドメイン側には無い（部分返金は注文の `refund_status` が持つ）。
 * `as` で黙らせると、いつか `partially_refunded` の行が
 * 「知らない状態」として画面へ出る。
 */
function toPaymentStatus(status: PaymentRow['status']): PaymentAttemptView['status'] {
  switch (status) {
    case 'pending':
    case 'succeeded':
    case 'failed':
    case 'cancelled':
    case 'refunded':
      return status;
    case 'partially_refunded':
      // 決済行としては「返金が始まっている」。細かい区別は注文側が持つ。
      return 'refunded';
  }
}

function toAttempt(row: PaymentRow): PaymentAttemptView {
  return {
    id: row.id,
    provider: row.provider,
    status: toPaymentStatus(row.status),
    sessionRef: row.providerSessionRef,
    paymentRef: row.providerPaymentRef,
    chargeRef: row.providerChargeRef,
    url: row.checkoutUrl,
    amount: row.amount,
    currency: row.currency.trim(),
    expiresAt: row.expiresAt,
    paidAt: row.paidAt,
    failureCode: row.failureCode,
    createdAt: row.createdAt,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
