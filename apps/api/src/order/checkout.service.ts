import { Injectable } from '@nestjs/common';
import type { CheckoutSessionResponse } from '@sengoku/contracts';
import {
  decideCheckout,
  isSessionUsable,
  type AuditLogPort,
  type ClockPort,
  type IdGeneratorPort,
  type CheckoutSessionCreated,
  type OrderRepository,
  type PaymentAttemptView,
  type PaymentGatewayPort,
  type PaymentRepository,
} from '@sengoku/domain';
import { DomainErrorException } from '../common/domain-error.filter';

export interface CheckoutServiceConfig {
  readonly provider: string;
  /**
   * 最終確認画面に出すべき事項（特商法12条の6）を、いま掲げられるか。
   *
   * ⚠️ **「表示したか」ではなく「表示できるか」。** 実際に出すのは画面の
   * 仕事で、ここは出すものが揃っているかだけを見る。
   *
   * ⚠️ **揃っていなければ支払い口を作らせない。** 表示義務を果たせない
   * 状態での通信販売は、販売そのものが法に触れる。手数料率が 0 のときに
   * 作らせないのと同じ考え方で、「売れない」ほうへ倒す。
   */
  readonly canDiscloseCheckoutTerms: () => Promise<boolean>;
  /**
   * 本番販売を始めてよい状態か（実運営 指示書 P0-7）。
   *
   * ⚠️ **画面を隠すだけにしない。** 管理画面で「準備中」と出しても、
   * この口は直接叩ける。**API 側でも断る**のがこの引数の役目である。
   *
   * ⚠️ **満たしていなければ例外を投げる。** 真偽値ではなく例外にして
   * あるのは、呼び出し側が戻り値を見忘れても止まるようにするため。
   *
   * ⚠️ **本番でだけ止まる。** staging では判定はするが通す。実装は
   * `ProductionReadinessService.assertSellable`。
   */
  readonly assertSellable: () => Promise<void>;
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

    /*
      ⚠️ **在庫や金額より先に見る。** 掲げるものが無ければ、そもそも
         この申込みを受けられない。あとから弾くと、購入者に手間を
         かけさせてから断ることになる。
      ⚠️ 購入者には設定の中身を見せない。手数料率が未設定のときと
         同じ符号にして、「準備中」とだけ伝える。
    */
    /*
      本番販売ガード（P0-7）。
      ⚠️ **在庫や金額より先に見る。** 売ってよい状態でないなら、そもそも
         この申込みを受けられない。あとから弾くと、購入者に手間をかけさせて
         から断ることになる。
      ⚠️ **理由の内訳を購入者へ出さない。** どの条件が欠けているかは
         運営の内部事情である。断る言葉は「準備中」で揃える。
    */
    await this.config.assertSellable();

    if (!(await this.config.canDiscloseCheckoutTerms())) {
      await this.audit.record({
        actorAccountId: input.accountId,
        action: 'checkout.rejected',
        targetType: 'order',
        targetId: order.id,
        summary: { reason: 'TOKUSHOHO_NOT_PUBLISHED', orderNumber: order.orderNumber },
      });
      throw new DomainErrorException('SALES_SETUP_INCOMPLETE');
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
      // ⚠️ どの世代の鍵で作ったか（`UD-128`）。返金にこれが要る。
      credentialId: created.credentialId,
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
  ): Promise<CheckoutSessionCreated> {
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
