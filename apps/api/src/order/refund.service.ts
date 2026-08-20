import { Injectable, NotFoundException } from '@nestjs/common';
import {
  decideRefund,
  type AuditLogPort,
  type ClockPort,
  type IdGeneratorPort,
  type PaymentGatewayPort,
  type RefundContext,
  type RefundDecision,
  type RefundReason,
  type RefundRecordView,
  type RefundRepository,
  type RefundSettlement,
} from '@sengoku/domain';
import type { Logger } from '@sengoku/observability';
import { DomainErrorException } from '../common/domain-error.filter';

/**
 * 返金の実行（`UD-104` / `UD-120`）。
 *
 * 手順に意味がある:
 *   1. 判定（`decideRefund`）——返してよいか
 *   2. 記録（`requested`）——**送信より先**
 *   3. 送信（決済事業者）——トランザクションの外
 *   4. 反映（`settle`）——注文・受取権・発行ジョブ・在庫を 1 トランザクションで
 *
 * ⚠️ **2 と 3 の順序を入れ替えない。** 送信してから記録すると、その間に
 * 落ちたときに「返金したのに記録が無い」が残る。お金の食い違いのうち、
 * いちばん見つけにくい形である。逆（記録だけ残って送信していない）は
 * `requested` のまま残るので、洗い出せる。
 *
 * ⚠️ **3 をトランザクションに入れない。** 外部への往復は数秒かかる。
 * 注文の行を握ったまま待つと、その注文に触る操作が全部止まる。
 */

/** 返金 1 件の結果。⚠️ 何が起きたかを丸めずに返す。 */
export interface RefundOutcome {
  readonly refund: RefundRecordView;
  readonly settlement: RefundSettlement;
}

export interface RefundRequest {
  readonly orderId: string;
  readonly reason: RefundReason;
  readonly actorAccountId: string | null;
  /**
   * 発行が進んだ注文でも進める、という運営の判断（`UD-104`）。
   *
   * ⚠️ **既定で真にしない。** 「発行済みは回収できない」を、押し慣れで
   * 越えられるようにしない。画面は必ず 1 度断ってから出し直す。
   */
  readonly acknowledgeIssued: boolean;
  readonly note: string | null;
}

@Injectable()
export class RefundService {
  constructor(
    private readonly refunds: RefundRepository,
    /**
     * 決済事業者。⚠️ 繋いでいない配備では `null`。
     *
     * ⚠️ **`null` を「返金できた」に倒さない。** 記録だけ残して成功を
     * 返すと、返っていないのに返金済みの注文ができる。断る。
     */
    private readonly gateway: PaymentGatewayPort | null,
    private readonly clock: ClockPort,
    private readonly ids: IdGeneratorPort,
    private readonly audit: AuditLogPort,
    private readonly logger: Logger,
  ) {}

  listByOrder(orderId: string): Promise<readonly RefundRecordView[]> {
    return this.refunds.listByOrder(orderId);
  }

  /**
   * 運営の操作による返金。
   *
   * ⚠️ **全額だけ。** 一部返金は自動処理しない決定（`UD-104`）。額を
   * 画面から受け取る口を作ると、桁を 1 つ多く打った操作がそのまま通る。
   */
  async refundByAdmin(request: RefundRequest): Promise<RefundOutcome> {
    const now = this.clock.now();
    const context = await this.loadContextOrThrow(request.orderId);

    const decision = this.decide(context, request.reason, now);
    if (decision.kind === 'needs_review' && !request.acknowledgeIssued) {
      /*
        ⚠️ **「できない」ではない。** 機械が決めないだけで、判断のうえで
           返すことはある。画面はこの符号を受けて、注記つきで出し直す。
      */
      this.logger.warn(
        { orderId: context.orderId, note: decision.note },
        '発行が進んでいるため、自動では返金しませんでした',
      );
      throw new DomainErrorException('REFUND_NEEDS_REVIEW');
    }

    // 残額。⚠️ 総額ではない。一部返金済みの注文で二重に返さないため。
    const amount = context.totalAmount - context.amountRefunded;
    if (amount <= 0) {
      throw new DomainErrorException('REFUND_ALREADY_DONE');
    }

    const refund = await this.refunds.start({
      refundId: this.ids.generate(),
      orderId: context.orderId,
      paymentId: context.paymentId,
      amount,
      currency: context.currency,
      reason: request.reason,
      initiatedBy: 'admin',
      actorAccountId: request.actorAccountId,
      // まだ投げていない。⚠️ 事業者の識別子はここでは分からない。
      providerRefundRef: null,
      note: request.note,
      now,
    });

    const gateway = this.gateway;
    if (gateway === null) {
      throw new DomainErrorException('PAYMENT_PROVIDER_DISABLED');
    }

    const executed = await gateway.refundPayment({
      // ⚠️ 決済した当時の世代で投げる（`UD-118` §2）。
      credentialId: context.credentialId,
      paymentRef: context.paymentRef,
      chargeRef: context.chargeRef,
      amount,
      currency: context.currency,
      reason: request.reason,
      // ⚠️ 行の識別子から作る。再試行しても事業者側では 1 回になる。
      idempotencyKey: `refund_${refund.id}`,
    });

    if (!executed.ok) {
      await this.refunds.fail({ refundId: refund.id, failureCode: executed.error.code, now });
      await this.audit.record({
        actorAccountId: request.actorAccountId,
        action: 'refund.failed',
        targetType: 'order',
        targetId: context.orderId,
        // ⚠️ 事業者の応答本文は残さない。符号と額まで。
        summary: { refundId: refund.id, amount, code: executed.error.code },
      });
      this.logger.error(
        { orderId: context.orderId, code: executed.error.code },
        '決済事業者へ返金の依頼が届きませんでした',
      );
      throw new DomainErrorException(executed.error.code);
    }

    const settlement = await this.applySettlement({
      refundId: refund.id,
      context,
      decision,
      providerRefundRef: executed.value.refundRef,
      amountRefundedTotal: context.amountRefunded + executed.value.amount,
      now,
    });

    await this.audit.record({
      actorAccountId: request.actorAccountId,
      action: 'refund.succeeded',
      targetType: 'order',
      targetId: context.orderId,
      summary: {
        refundId: refund.id,
        amount: executed.value.amount,
        reason: request.reason,
        /*
          ⚠️ **事業者側でまだ処理中かを残す。** 銀行振込の返金は日を
             またぐ。残しておかないと、「返金したのに入っていない」と
             言われたときに、こちら側の記録だけでは説明できない。
        */
        providerPending: executed.value.pending,
        revokedEntitlements: settlement.revokedEntitlements,
        cancelledMintJobs: settlement.cancelledMintJobs,
        annotatedMintJobs: settlement.annotatedMintJobs,
      },
    });

    const refreshed = await this.refunds.listByOrder(context.orderId);
    return { refund: refreshed.find((row) => row.id === refund.id) ?? refund, settlement };
  }

  /**
   * 決済事業者の画面から返金されたぶんを追随する（`UD-120`）。
   *
   * ⚠️ **これを「例外的な経路」と考えない。** 運営が慌てて事業者の管理
   * 画面から返金するのは実際に起きる。追随しないと、返金済みの注文が
   * こちらでは「お支払い済み」のまま残り、精算にまで乗る。
   *
   * @returns 追随したときだけ結果。何も新しくなければ `null`。
   */
  async followProviderRefund(input: {
    readonly orderId: string;
    readonly providerRefundRef: string | null;
    readonly refundedTotal: number;
    readonly now: Date;
  }): Promise<RefundOutcome | null> {
    /*
      ⚠️ **こちらから投げた返金にも、あとから知らせが届く。** 識別子で
         引き当てて、同じ返金を 2 回積まないようにする。
    */
    if (input.providerRefundRef !== null) {
      const known = await this.refunds.findByProviderRef(input.providerRefundRef);
      if (known !== null) {
        return null;
      }
    }

    const context = await this.refunds.loadContext(input.orderId);
    if (context === null) {
      return null;
    }

    /*
      ⚠️ **累計の差分を取る。** 事業者は累計で持つので、知らせが前後して
         届いても、差分で見れば二重に積まれない。差が無ければ何もしない。
    */
    const delta = input.refundedTotal - context.amountRefunded;
    if (delta <= 0) {
      return null;
    }

    /*
      ⚠️ **判定で断られても記録は残す。** もう返金は起きている。
         こちらの都合で「対象外」にしても、事実は変わらない。
    */
    const decision = this.decide(context, 'provider_initiated', input.now);

    const refund = await this.refunds.start({
      refundId: this.ids.generate(),
      orderId: context.orderId,
      paymentId: context.paymentId,
      amount: delta,
      currency: context.currency,
      reason: 'provider_initiated',
      initiatedBy: 'provider',
      // ⚠️ 運営の誰かを紐づけない。こちらを経由していない返金である。
      actorAccountId: null,
      providerRefundRef: input.providerRefundRef,
      note: '決済事業者の画面からの返金に追随しました。',
      now: input.now,
    });

    /*
      ⚠️ **一部返金では受取権も発行ジョブも動かさない**（`UD-104` の
         「一部返金は自動処理しない」）。金額だけを記録する。全部返って
         はじめて、渡したものを取り消す判断になる。
    */
    const fullyRefunded = input.refundedTotal >= context.totalAmount;
    const settlement = await this.applySettlement({
      refundId: refund.id,
      context,
      decision: fullyRefunded ? decision : null,
      providerRefundRef: input.providerRefundRef,
      amountRefundedTotal: input.refundedTotal,
      now: input.now,
    });

    await this.audit.record({
      actorAccountId: null,
      action: 'refund.followed_provider',
      targetType: 'order',
      targetId: context.orderId,
      summary: {
        refundId: refund.id,
        amount: delta,
        refundedTotal: input.refundedTotal,
        fullyRefunded,
      },
    });

    return { refund, settlement };
  }

  private async loadContextOrThrow(orderId: string): Promise<RefundContext> {
    const context = await this.refunds.loadContext(orderId);
    if (context === null) {
      // ⚠️ 「返金できない」ではなく「その注文が無い」。符号を分ける。
      throw new NotFoundException();
    }
    return context;
  }

  /**
   * 返してよいかを決める。
   *
   * ⚠️ **設定を読まない。** 期限は注文へ焼き付けた値をそのまま渡す。
   * ここで「いまの設定」を引くと、日数を延ばした瞬間に精算済みの注文が
   * 「まだ返金できる」に化ける（`SETTLEMENT_AND_REFUND.md` §0）。
   */
  private decide(context: RefundContext, reason: RefundReason, now: Date): RefundDecision {
    const decided = decideRefund({
      paymentStatus: context.paymentStatus as Parameters<typeof decideRefund>[0]['paymentStatus'],
      refundStatus: context.refundStatus,
      refundableUntil: context.refundableUntil,
      entitlementStatus: context.entitlementStatus,
      mintStatus: context.mintStatus,
      reason,
      now,
    });
    if (!decided.ok) {
      throw new DomainErrorException(decided.error.code);
    }
    return decided.value;
  }

  /**
   * 反映。
   *
   * `decision` が `null` のときは金額だけを記録する（一部返金）。
   * ⚠️ **渡したものを取り消すのは、全額返ったときだけ。**
   */
  private applySettlement(input: {
    readonly refundId: string;
    readonly context: RefundContext;
    readonly decision: RefundDecision | null;
    readonly providerRefundRef: string | null;
    readonly amountRefundedTotal: number;
    readonly now: Date;
  }): Promise<RefundSettlement> {
    const effects = input.decision?.effects ?? null;
    return this.refunds.settle({
      refundId: input.refundId,
      orderId: input.context.orderId,
      providerRefundRef: input.providerRefundRef,
      amountRefundedTotal: input.amountRefundedTotal,
      revokeEntitlement: effects?.revokeEntitlement ?? false,
      cancelMintJob: effects?.cancelMintJob ?? false,
      /*
        ⚠️ **`processing` は取り消さず、注記だけ足す**（`INV-M4`）。
           外部へ送信済みの可能性があり、多重発行は回復できない。
      */
      mintNote:
        input.context.mintStatus === 'processing'
          ? '返金されましたが、外部へ送信済みの可能性があるため取り消していません。'
          : null,
      now: input.now,
    });
  }
}
