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
import type { WalletAutoDeliveryService } from '../claim/auto-delivery.service';
import type { EntitlementIssuanceService } from './issuance.service';
import type { RefundService } from './refund.service';

export interface WebhookServiceConfig {
  readonly provider: string;
  /** この配備が本番の決済を扱うか。⚠️ 事業者の `livemode` と突き合わせる。 */
  readonly expectLivemode: boolean;
  /**
   * 返金を受け付ける期限を決める（`UD-104`）。
   *
   * ⚠️ **決済確定のたびに引く。** 引いた値は注文へ焼き付けられるので、
   * あとから設定を変えても**過去の注文は動かない**。
   * ⚠️ 設定が無い配備では `null` を返す。既定値を作らない。
   */
  readonly resolveRefundableUntil: (paidAt: Date) => Promise<Date | null>;
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
    /**
     * 事業者の画面からの返金に追随する（`UD-120`）。
     *
     * ⚠️ **省略できるようにしていない。** 追随しないと、返金済みの注文が
     * こちらでは「お支払い済み」のまま残り、精算にまで乗る。
     */
    private readonly refunds: RefundService,
    /**
     * 受取権の発行（P0-1）。
     *
     * ⚠️ **省略できるようにしていない。** 発行しないと、決済が済んだのに
     * 受け取るものが生まれない。Claim も Wallet 配送も、この一段が
     * 無いと一度も動かない。
     */
    private readonly issuance: EntitlementIssuanceService,
    /**
     * Wallet への自動配送（P0-2）。
     *
     * ⚠️ **`null` は「まだ Wallet へ繋がない」を意味する。** 繋がない配備
     * では届けにいかない。受取権はできているので、繋いだあとに掃き出しが拾う。
     */
    private readonly autoDelivery: WalletAutoDeliveryService | null = null,
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

    const verified = await this.gateway.verifyAndParseWebhook(rawBody, signatureHeader);
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
      // ⚠️ どの世代の鍵で署名を検証できたか（`UD-128`）。
      credentialId: fact.credentialId,
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

    if (fact.kind === 'refunded') {
      await this.follow(fact, order.id, order.orderNumber, now);
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

  /**
   * 事業者の画面からの返金に追随する（`UD-120`）。
   *
   * ⚠️ **こちらから投げた返金にも、この知らせは届く。** 二重に積まない
   * 判定は `RefundService` が識別子で行う。ここでは判定しない。
   *
   * ⚠️ **追随に失敗しても 200 を返す。** 4xx/5xx を返すと事業者が再送し
   * 続け、いずれ宛先ごと無効化される。失敗は記録に残して人が拾う。
   */
  private async follow(
    fact: ProviderPaymentFact,
    orderId: string,
    orderNumber: string,
    now: Date,
  ): Promise<void> {
    if (fact.refundedTotal === null) {
      // 累計が読めない知らせでは金額を動かせない。⚠️ 推測で埋めない。
      await this.recordAndFinish(fact, 'ignored', orderId, 'refund_total_missing', now);
      return;
    }

    try {
      const outcome = await this.refunds.followProviderRefund({
        orderId,
        providerRefundRef: fact.refundRef,
        refundedTotal: fact.refundedTotal,
        now,
      });
      await this.audit.record({
        actorAccountId: null,
        action: outcome === null ? 'payment.refund_already_known' : 'payment.refunded',
        targetType: 'order',
        targetId: orderId,
        summary: { orderNumber, refundedTotal: fact.refundedTotal },
      });
      await this.recordAndFinish(fact, 'processed', orderId, null, now);
    } catch {
      /*
        ⚠️ **例外の中身をログへ出さない。** 返金の処理には金額が載る。
           運営が知りたいのは「追随できなかった注文がある」までで、
           詳しくは注文の画面で見るほうが正確。
      */
      this.logger.error({ orderId }, '事業者からの返金に追随できませんでした');
      await this.recordAndFinish(fact, 'failed', orderId, 'refund_follow_failed', now);
    }
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
      // ⚠️ ここで確定して焼き付ける（`UD-104`）。判定のたびに計算しない。
      refundableUntil: await this.config.resolveRefundableUntil(fact.occurredAt),
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

    /*
      受取権をこの場で作る（P0-1）。

      ⚠️ **失敗しても決済の確定を巻き戻さない。** お金は既に動いている。
         巻き戻すと「払ったのに注文が無い」になる。発行の失敗は注文へ
         記録され、時計からの掃き出し
         （`/api/v1/internal/jobs/issue-entitlements`）が拾い直す。

      ⚠️ **ここを唯一の起動口にしない。** この直後にプロセスが落ちた注文は
         永久に発行されなくなる。掃き出しと併せて 2 本立てにする。

      ⚠️ **何度呼ばれても増えない。** 足りない枚数だけを作る形にしてあり、
         `UNIQUE(order_line_id, unit_index)` が最終防壁になっている。
         同じ知らせが 2 度届いても、ここは安全に通る。
    */
    const issued = await this.issuance.runForOrder(order.id);

    /*
      受取用のウォレットを登録済みの方には、その場で届けにいく（P0-2）。

      ⚠️ **未登録の方をここで待たない。** 登録が済んだ時点で、掃き出し
         （`/api/v1/internal/jobs/deliver-entitlements`）が拾い直す。
      ⚠️ **失敗しても決済の知らせは 200 で返す。** 決済も発行も済んでいる。
         ここで投げると同じ知らせが送り直され、いずれ宛先ごと無効化される。
    */
    if (issued !== null && issued.entitlementIds.length > 0 && this.autoDelivery !== null) {
      await this.autoDelivery.runForEntitlements(issued.entitlementIds);
    }

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
