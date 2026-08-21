import { Injectable, NotFoundException } from '@nestjs/common';
import {
  decideRefund,
  type AuditLogPort,
  type ClockPort,
  type IdGeneratorPort,
  type OperationsReviewRepository,
  type PaymentGatewayPort,
  type RefundContext,
  type RefundDecision,
  type RefundReason,
  type RefundRecordView,
  type RefundRepository,
  type RefundSettlement,
  type RevocationPlanner,
} from '@sengoku/domain';
import type { Logger } from '@sengoku/observability';
import { DomainErrorException } from '../common/domain-error.filter';
import { BuyerNotifier, NULL_NOTIFIER } from '../notification/buyer-notifier';

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
    /**
     * 受取済み（`claimed`）も取り消すか（`UD-104` 追補）。
     *
     * ⚠️ **段階導入のためのフラグ。** 偽のあいだは従来どおり未受取だけを
     * 取り消す。真にすると受取済みも `revoked` へ進むが、
     * `claimed_at` などの受取記録は**残したまま**である。
     */
    private readonly revokeClaimedEntitlements: boolean = false,
    /**
     * 取消イベントの組み立て。⚠️ **`null` なら作らない**（生成フラグが無効）。
     *
     * ⚠️ Nest の任意注入は `undefined` を渡してくる。境界で `?? null` に
     * そろえること（P0-2 で同型の不具合を出した）。
     */
    private readonly planRevocation: RevocationPlanner | null = null,
    /** 機械が決められなかったことを積む先。 */
    private readonly reviews: OperationsReviewRepository | null = null,
    /** 購入者への知らせ（P0-4）。⚠️ 例外を投げない実装を渡す。 */
    private readonly notifier: BuyerNotifier = NULL_NOTIFIER,
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

    /*
      ご返金の手続きを始めた知らせ（P0-4）。

      ⚠️ **記録の直後、事業者へ投げる前に積む。** 投げたあとにすると、
         投げた直後に落ちたときへ「返金を始めました」が届かない。
         逆（積んだが投げられなかった）は、返金の行が `requested` のまま
         残るので運用で拾える。
    */
    await this.notifier.refundRequested({
      refundId: refund.id,
      accountId: context.accountId,
      orderId: context.orderId,
      orderNumber: context.orderNumber,
    });

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
        // ⚠️ 件数だけ。受取権IDや共通顧客IDは監査へ載せない。
        revocationEventsCreated: settlement.revocationEventsCreated,
        revocationEventsDuplicate: settlement.revocationEventsDuplicate,
        supersededGrantedEvents: settlement.supersededGrantedEvents,
        revocationsNeedingReview: settlement.revocationsNeedingReview.length,
        revocationPayloadConflicts: settlement.revocationPayloadConflicts.length,
      },
    });

    this.reportRevocation(context.orderId, settlement);

    /*
      ご返金が完了した知らせ（P0-4）。

      ⚠️ **反映が済んでから積む。** 先に積むと、反映に失敗したときに
         「返金が完了しました」だけが届く。
    */
    await this.notifier.refundCompleted({
      refundId: refund.id,
      accountId: context.accountId,
      orderId: context.orderId,
      orderNumber: context.orderNumber,
      refundAmount: executed.value.amount,
      currency: context.currency,
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
        revokedEntitlements: settlement.revokedEntitlements,
        revocationEventsCreated: settlement.revocationEventsCreated,
        revocationEventsDuplicate: settlement.revocationEventsDuplicate,
        supersededGrantedEvents: settlement.supersededGrantedEvents,
        revocationsNeedingReview: settlement.revocationsNeedingReview.length,
        revocationPayloadConflicts: settlement.revocationPayloadConflicts.length,
      },
    });

    this.reportRevocation(context.orderId, settlement);
    if (!fullyRefunded) {
      /*
        ⚠️ **一部返金では受取権を自動で取り消さない**（`UD-104`）。
           数量や明細を指定して返金する経路が無く、どのシリアルを
           取り消すべきかは機械には決められない。人の確認へ回す。
      */
      await this.reviewPartialRefund(context.orderId, refund.id, input.now);
    }

    /*
      ⚠️ **事業者の画面からの返金でも知らせる。** こちらを経由していない
         だけで、買った方から見れば同じ「返金された」である。
    */
    await this.notifier.refundCompleted({
      refundId: refund.id,
      accountId: context.accountId,
      orderId: context.orderId,
      orderNumber: context.orderNumber,
      refundAmount: delta,
      currency: context.currency,
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
      // ⚠️ 設定を読まない。段階導入のフラグは呼び出し側が持つ。
      revokeClaimedEntitlements: this.revokeClaimedEntitlements,
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
      revokeClaimedEntitlements: this.revokeClaimedEntitlements,
      planRevocation: this.planRevocation,
      now: input.now,
    });
  }

  /**
   * 取消の結果のうち、**人が知るべきこと**を外へ出す。
   *
   * ⚠️ **返金の成否を変えない。** ここで投げると、決済事業者へ届いている
   * 返金の記録だけが消える。伝えるだけにとどめる。
   *
   * 運用確認の行そのものは返金と同じトランザクションで積んである。
   * ここでやるのは、監視が拾えるようログへ出すことだけ。
   */
  private reportRevocation(orderId: string, settlement: RefundSettlement): void {
    for (const item of settlement.revocationsNeedingReview) {
      this.logger.warn(
        { orderId, entitlementId: item.entitlementId, reason: item.reason },
        '取り消しましたが、お届け先が特定できないため通知していません',
      );
    }
    for (const conflict of settlement.revocationPayloadConflicts) {
      /*
        ⚠️ **無言で成功にしない。** 冪等キーが同じで中身が違う以上、
           どちらが相手に保存されたのかこちらからは分からない。
        ⚠️ 本文そのものは出さない。突き合わせに要るのはハッシュまで。
      */
      this.logger.error(
        {
          orderId,
          entitlementId: conflict.entitlementId,
          eventId: conflict.eventId,
          expectedPayloadHash: conflict.expectedPayloadHash,
          actualPayloadHash: conflict.actualPayloadHash,
        },
        '同じイベントIDで本文が食い違いました。運用確認へ回しています',
      );
    }
  }

  /**
   * 一部返金で、取り消す対象を確定できないことを記録する。
   *
   * ⚠️ **ログだけで済ませない。** ログは流れて消える。数量や明細を指定して
   * 返金する経路が無い以上、どのシリアルを取り消すべきかは人にしか
   * 決められない。未対応と分かる形で残さないと、そのまま埋もれる。
   *
   * ⚠️ **推測で取り消さない。** 間違えると、返金と無関係な作品が
   * 利用者の手元から消える。
   *
   * ⚠️ **ここで投げない。** 返金はもう成立している。
   */
  private async reviewPartialRefund(orderId: string, refundId: string, now: Date): Promise<void> {
    this.logger.warn(
      { orderId, refundId },
      '一部返金のため、取り消す受取権を自動では決めていません',
    );
    if (this.reviews === null) {
      return;
    }
    try {
      await this.reviews.open({
        subjectType: 'order',
        subjectId: orderId,
        orderId,
        reasonCode: 'partial_refund_entitlement_unresolved',
        // ⚠️ 個人情報を入れない。識別子と、決められなかった理由まで。
        detail: `一部返金のため、取り消す数量・受取権・シリアルを確定できませんでした（refundId=${refundId}）。`,
        now,
      });
    } catch (error) {
      // 積めなくても返金は成立している。⚠️ ここで投げ返さない。
      this.logger.error({ orderId, refundId, error }, '運用確認へ積めませんでした');
    }
  }
}
