import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  isLivemodeConsistent,
  verifyPaymentFact,
  type AuditLogPort,
  type ClockPort,
  type IdGeneratorPort,
  type OrderRepository,
  type PaymentGatewayPort,
  type PaymentRepository,
  type ProviderPaymentFact,
} from '@sengoku/domain';
import type { Logger } from '@sengoku/observability';

export interface WebhookServiceConfig {
  readonly provider: string;
  /** この配備が本番の決済を扱うか。⚠️ 事業者の `livemode` と突き合わせる。 */
  readonly expectLivemode: boolean;
}

/**
 * 決済事業者からの知らせを受ける（決済 Phase P2・指示書 §5.4）。
 *
 * ⚠️ **注文を `paid` にできるのは、ここだけ。** ブラウザが成功URLへ
 * 戻ったことは根拠にしない（指示書 §4-3）。戻りは誰でも作れる。
 *
 * ⚠️ **常に速く応答する。** 長い外部連携をここでしない。次の工程は
 * Outbox に置いて、別のワーカーが拾う。
 *
 * ⚠️ **署名を確かめる前の本文を、解釈も記録もしない。**
 * 検証前の本文は送り主が中身を決められるデータ。
 */
@Injectable()
export class PaymentWebhookService {
  constructor(
    private readonly gateway: PaymentGatewayPort,
    private readonly payments: PaymentRepository,
    private readonly orders: OrderRepository,
    private readonly clock: ClockPort,
    private readonly ids: IdGeneratorPort,
    private readonly audit: AuditLogPort,
    private readonly logger: Logger,
    private readonly config: WebhookServiceConfig,
  ) {}

  /**
   * 受け取って処理する。
   *
   * @returns 署名が正しければ `true`。呼び出し側は 200 を返す。
   * ⚠️ **処理できなかったときも 200 を返す**（署名さえ正しければ）。
   * 4xx/5xx を返すと事業者が再送し続け、いずれ宛先ごと無効化される。
   */
  async handle(rawBody: Buffer, signatureHeader: string | undefined): Promise<boolean> {
    const now = this.clock.now();

    if (signatureHeader === undefined || signatureHeader === '') {
      await this.audit.record({
        actorAccountId: null,
        action: 'payment.webhook_signature_missing',
        targetType: 'payment',
        targetId: null,
        summary: { provider: this.config.provider },
      });
      return false;
    }

    const verified = this.gateway.verifyAndParseWebhook(rawBody, signatureHeader);
    if (!verified.ok) {
      // ⚠️ 本文を記録しない。何が届いたかは事業者側のダッシュボードで見る。
      await this.audit.record({
        actorAccountId: null,
        action: 'payment.webhook_signature_invalid',
        targetType: 'payment',
        targetId: null,
        summary: { provider: this.config.provider },
      });
      return false;
    }

    const fact = verified.value;

    // ⚠️ 本番と試験の取り違え。試験の知らせで本番の注文を確定させない。
    if (!isLivemodeConsistent(fact, this.config.expectLivemode)) {
      await this.recordAndFinish(fact, 'ignored', null, 'livemode_mismatch', now);
      this.logger.warn(
        { provider: this.config.provider, eventType: fact.eventType },
        '本番・試験の別が食い違う通知を無視しました',
      );
      return true;
    }

    /*
      同じ知らせを 2 回処理しない。
      ⚠️ **`(provider, event_id)` の UNIQUE で決める。** 「探して無ければ
         書く」にすると、同時に届いた同じ知らせを 2 本とも処理してしまう。
    */
    const claim = await this.payments.claimWebhookEvent({
      id: this.ids.generate(),
      provider: this.config.provider,
      eventId: fact.eventId,
      eventType: fact.eventType,
      apiVersion: fact.apiVersion,
      livemode: fact.livemode,
      // ⚠️ 本文の全体ではなく digest。個人情報もカード情報も残さない。
      payloadDigest: digestOf(rawBody),
      orderId: fact.orderId,
      now,
    });
    if (claim.kind === 'duplicate') {
      await this.audit.record({
        actorAccountId: null,
        action: 'payment.webhook_duplicate',
        targetType: 'order',
        targetId: fact.orderId,
        summary: { eventType: fact.eventType },
      });
      // ⚠️ 成功として返す。再送させない。
      return true;
    }

    if (fact.kind === 'ignored' || fact.orderId === null) {
      await this.recordAndFinish(fact, 'ignored', null, null, now);
      return true;
    }

    const order = await this.orders.findById(fact.orderId);
    if (order === null) {
      await this.recordAndFinish(fact, 'ignored', null, 'order_not_found', now);
      return true;
    }

    if (fact.kind === 'succeeded') {
      await this.confirm(fact, order, now);
      return true;
    }

    if (fact.kind === 'failed') {
      await this.payments.recordFailure({
        orderId: order.id,
        sessionRef: fact.sessionRef,
        paymentRef: fact.paymentRef,
        failureCode: fact.failureCode ?? 'unknown',
        now,
      });
      await this.audit.record({
        actorAccountId: null,
        action: 'payment.failed',
        targetType: 'order',
        targetId: order.id,
        summary: { orderNumber: order.orderNumber, failureCode: fact.failureCode ?? 'unknown' },
      });
      await this.recordAndFinish(fact, 'processed', order.id, fact.failureCode, now);
      return true;
    }

    // checkout_expired
    const released = await this.payments.expireCheckout({
      orderId: order.id,
      sessionRef: fact.sessionRef,
      now,
    });
    await this.audit.record({
      actorAccountId: null,
      action: 'payment.checkout_expired',
      targetType: 'order',
      targetId: order.id,
      // ⚠️ 二重解放していないことが後から分かるように、結果を残す。
      summary: { orderNumber: order.orderNumber, released },
    });
    await this.recordAndFinish(fact, 'processed', order.id, null, now);
    return true;
  }

  private async confirm(
    fact: ProviderPaymentFact,
    order: NonNullable<Awaited<ReturnType<OrderRepository['findById']>>>,
    now: Date,
  ): Promise<void> {
    const attempts = await this.payments.listAttempts(order.id);
    const matching = attempts.find(
      (attempt) =>
        (fact.sessionRef !== null && attempt.sessionRef === fact.sessionRef) ||
        (fact.paymentRef !== null && attempt.paymentRef === fact.paymentRef),
    );

    /*
      ⚠️ **金額・通貨・注文ID・支払い口を確かめてから確定する**（指示書 §7）。
         1 つでも合わなければ `paid` にしない。額が違う知らせで確定すると、
         少ない入金で商品を渡すことになる。
    */
    const verification = verifyPaymentFact(fact, {
      orderId: order.id,
      totalAmount: order.totalAmount,
      currency: order.currency,
      sessionRef: matching?.sessionRef ?? null,
      paymentRef: matching?.paymentRef ?? null,
      hasSucceededPayment: attempts.some((attempt) => attempt.status === 'succeeded'),
    });

    if (!verification.ok) {
      await this.audit.record({
        actorAccountId: null,
        action: 'payment.mismatch',
        targetType: 'order',
        targetId: order.id,
        // ⚠️ 何が合わなかったかは残すが、届いた値そのものは残さない。
        summary: { orderNumber: order.orderNumber, reason: verification.error.code },
      });
      this.logger.error(
        { orderId: order.id, eventType: fact.eventType },
        '決済の内容が注文と一致しないため確定しませんでした',
      );
      await this.recordAndFinish(fact, 'failed', order.id, 'mismatch', now);
      return;
    }

    const confirmed = await this.payments.confirmPayment({
      orderId: order.id,
      provider: this.config.provider,
      eventId: fact.eventId,
      sessionRef: fact.sessionRef,
      paymentRef: fact.paymentRef,
      chargeRef: fact.chargeRef,
      amount: fact.amount ?? order.totalAmount,
      currency: order.currency,
      paidAt: fact.occurredAt,
      outboxEventId: this.ids.generate(),
      now,
    });

    await this.audit.record({
      actorAccountId: null,
      action: confirmed ? 'payment.succeeded' : 'payment.already_confirmed',
      targetType: 'order',
      targetId: order.id,
      summary: { orderNumber: order.orderNumber, eventType: fact.eventType },
    });
    await this.recordAndFinish(fact, 'processed', order.id, null, now);
  }

  private async recordAndFinish(
    fact: ProviderPaymentFact,
    status: 'processed' | 'ignored' | 'failed',
    orderId: string | null,
    errorCode: string | null,
    now: Date,
  ): Promise<void> {
    await this.payments.markWebhookProcessed({
      provider: this.config.provider,
      eventId: fact.eventId,
      status,
      orderId,
      paymentId: null,
      errorCode,
      now,
    });
  }
}

/**
 * 本文の digest。
 *
 * ⚠️ **本文そのものを保存しない**（指示書 §10）。同じ知らせが届いたかを
 * 確かめるのに要るのはこれだけで、中身にはカード情報も個人情報も入りうる。
 */
function digestOf(rawBody: Buffer): string {
  return `sha256:${createHash('sha256').update(rawBody).digest('hex')}`;
}
