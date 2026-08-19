import { Injectable } from '@nestjs/common';
import type { CheckoutSessionResponse } from '@sengoku/contracts';
import {
  decideCheckout,
  isSessionUsable,
  type AuditLogPort,
  type ClockPort,
  type IdGeneratorPort,
  type OrderRepository,
  type PaymentAttemptView,
  type PaymentGatewayPort,
  type PaymentRepository,
} from '@sengoku/domain';
import { DomainErrorException } from '../common/domain-error.filter';

export interface CheckoutServiceConfig {
  readonly provider: string;
}

/**
 * 支払い口の作成（決済 Phase P2・指示書 §5.2）。
 *
 * ⚠️ **ブラウザから受け取るのは注文IDだけ。** 金額・通貨・商品名は
 * 注文のスナップショットから引く。ここへ引数を足さないこと。
 *
 * ⚠️ **決済事業者への往復を DB のトランザクションの中でしない**
 * （指示書 §4-10）。外部が数秒かかると、その間ずっと行ロックを握る。
 * 「判定 → 外部呼び出し → 記録」の 3 段に分けてある。
 */
@Injectable()
export class CheckoutService {
  constructor(
    private readonly orders: OrderRepository,
    private readonly payments: PaymentRepository,
    private readonly gateway: PaymentGatewayPort,
    private readonly clock: ClockPort,
    private readonly ids: IdGeneratorPort,
    private readonly audit: AuditLogPort,
    private readonly config: CheckoutServiceConfig,
  ) {}

  async create(input: {
    readonly orderId: string;
    readonly accountId: string;
    readonly correlationId: string | null;
  }): Promise<CheckoutSessionResponse> {
    const now = this.clock.now();

    const order = await this.orders.findById(input.orderId);
    // ⚠️ 他人の注文と存在しない注文を区別しない。区別すると、
    //    注文IDの総当たりで存在を確かめられる。
    if (order === null || order.accountId !== input.accountId) {
      throw new DomainErrorException('ARTWORK_NOT_AVAILABLE');
    }

    const attempts = await this.payments.listAttempts(order.id);
    const latest = attempts.find((attempt) => isSessionUsable(toSnapshot(attempt), now));

    // 1. 判定。⚠️ 外部を呼ぶ前に、通らない要求をここで弾く。
    const decision = decideCheckout({
      orderStatus: order.status,
      paymentStatus: order.paymentStatus,
      platformFeeRateBps: order.platformFeeRateBps,
      reservationExpiresAt: order.reservationExpiresAt,
      existingSession: latest === undefined ? null : toSnapshot(latest),
      now,
    });
    if (!decision.ok) {
      await this.audit.record({
        actorAccountId: input.accountId,
        action: 'checkout.rejected',
        targetType: 'order',
        targetId: order.id,
        summary: { reason: decision.error.code, orderNumber: order.orderNumber },
      });
      throw new DomainErrorException(decision.error.code);
    }

    if (decision.value.kind === 'reuse') {
      /*
        ⚠️ **事業者を呼ばない。** 保存してある URL へそのまま送る。
           呼び直すと冪等キーを作り直すことになり、**別の支払い口が
           できる**。実際にその不具合を作り、試験が捕まえた。
           「使い回す」とは、文字どおり同じ口を使うこと。
      */
      const session = decision.value.session;
      await this.audit.record({
        actorAccountId: input.accountId,
        action: 'checkout.session_reused',
        targetType: 'order',
        targetId: order.id,
        summary: { orderNumber: order.orderNumber, sessionRef: session.sessionRef },
      });
      return {
        checkoutUrl: session.url ?? '',
        expiresAt: session.expiresAt.toISOString(),
        reused: true,
      };
    }

    // 2. 外部呼び出し。トランザクションの外。
    const created = await this.callGateway(order, decision.value.expiresAt, input, attempts.length);

    /*
      3. 記録。
      ⚠️ **ここで落ちても、事業者側には口ができている。** 冪等キーが
         注文IDと試行回数から決まるので、次に押されたときに同じ口が返り、
         同じ行が作られる。取りこぼしても復旧できる形にしてある。
    */
    const recorded = await this.payments.recordCheckoutSession({
      paymentId: this.ids.generate(),
      orderId: order.id,
      provider: this.config.provider,
      sessionRef: created.sessionRef,
      paymentRef: created.paymentRef,
      url: created.url,
      amount: order.totalAmount,
      currency: order.currency,
      idempotencyKey: this.idempotencyKeyFor(order.id, attempts.length),
      expiresAt: created.expiresAt,
      now,
    });

    await this.audit.record({
      actorAccountId: input.accountId,
      action: 'checkout.session_created',
      targetType: 'order',
      targetId: order.id,
      summary: {
        orderNumber: order.orderNumber,
        // ⚠️ 秘密ではないが、金額と購入者は残さない。追跡に要るのは識別子。
        sessionRef: recorded.sessionRef,
        attempt: attempts.length + 1,
      },
    });

    return {
      checkoutUrl: created.url,
      expiresAt: created.expiresAt.toISOString(),
      reused: false,
    };
  }

  private async callGateway(
    order: NonNullable<Awaited<ReturnType<OrderRepository['findById']>>>,
    expiresAt: Date,
    input: { readonly correlationId: string | null },
    attemptCount: number,
  ): Promise<{ sessionRef: string; paymentRef: string | null; url: string; expiresAt: Date }> {
    const result = await this.gateway.createCheckoutSession({
      orderId: order.id,
      orderNumber: order.orderNumber,
      // ⚠️ 注文時点の作品名。マスタを引き直さない。
      itemName: order.item?.titleSnapshot ?? order.orderNumber,
      amount: order.totalAmount,
      currency: order.currency,
      quantity: order.item?.quantity ?? 1,
      expiresAt,
      // ⚠️ 冪等キーはサーバー側で作る（指示書 §5.2）。
      idempotencyKey: this.idempotencyKeyFor(order.id, attemptCount),
      correlationId: input.correlationId,
    });
    if (!result.ok) {
      throw new DomainErrorException(result.error.code);
    }
    return result.value;
  }

  /**
   * 事業者へ渡す冪等キー。
   *
   * ⚠️ **注文IDと試行回数から決める。** 乱数にすると、押すたびに
   * 別の口ができる。試行回数を含めるのは、失敗したあとに
   * **新しい口を作れるようにする**ため（決定 B）。
   */
  private idempotencyKeyFor(orderId: string, attemptCount: number): string {
    return `order:${orderId}:attempt:${String(attemptCount)}`;
  }
}

function toSnapshot(attempt: PaymentAttemptView): {
  paymentId: string;
  sessionRef: string;
  url: string | null;
  status: PaymentAttemptView['status'];
  expiresAt: Date;
} {
  return {
    paymentId: attempt.id,
    sessionRef: attempt.sessionRef ?? '',
    // URL が無い記録は使い回せない。`isSessionUsable` がそこを見る。
    url: attempt.url,
    status: attempt.status,
    expiresAt: attempt.expiresAt ?? new Date(0),
  };
}
