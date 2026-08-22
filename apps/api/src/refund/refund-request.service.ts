import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  addBusinessDays,
  canApprove,
  categoryOf,
  clawbackBearerFor,
  checkRefundAmount,
  creatorInquiryExpired,
  isBuyerSelectableReason,
  isExcludedByDefault,
  needsCreatorConfirmation,
  outstandingTotal,
  requiresDualApproval,
  suggestDisposition,
  type AuditLogPort,
  type ClawbackBearer,
  type ClockPort,
  type CreatorInquiryPort,
  type CreatorInquiryRecord,
  type CreatorReceivablePort,
  type EntitlementDisposition,
  type IdGeneratorPort,
  type IntegrationEnvironment,
  type OrderRepository,
  type ReceivableRecord,
  type RefundPolicyPort,
  type RefundRepository,
  type RefundRequestEventRecord,
  type RefundRequestPort,
  type RefundRequestReason,
  type RefundRequestRecord,
  type RefundRequestStatus,
} from '@sengoku/domain';
import type { Logger } from '@sengoku/observability';
import { DomainErrorException } from '../common/domain-error.filter';
import { RefundService } from '../order/refund.service';
import { BuyerNotifier, NULL_NOTIFIER } from '../notification/buyer-notifier';

/**
 * 返金の申請と審査（方針整理 2026-08-22）。
 *
 * 手続きの順序に意味がある:
 *
 *   申し出（購入者・運営）
 *     → 事実確認（作家さま。**要る事由のときだけ**。期限が来れば待たない）
 *     → 調査（運営）
 *     → 承認 or 却下（オーナー。額によっては**別の人**の 2 人目）
 *     → 実行（決済事業者へ投げる）
 *
 * ⚠️ **作家さまが決済事業者へ投げる口は、この仕組みに存在しない。**
 * 作家さまにあるのは「事実確認に答える」だけである。販売の代金は運営の
 * 決済アカウントで受けているので、返せるのも運営だけになる。
 *
 * ⚠️ **調べる人と、返すと決める人を分ける。** `refund_request.investigate`
 * と `refund_request.approve` を別の力にしてある（後者はオーナー限定）。
 *
 * ⚠️ **`executing` を経由してから投げる。** 経由しないと、2 回押された
 * ときに 2 回投げてしまう。状態を条件付き更新で取ったほうだけが進む。
 */

/** 注入の合図。⚠️ interface は実行時に消えるので、型では注入できない。 */
export const REFUND_REQUEST_CONFIG = Symbol('sengoku:refund-request-config');

export interface RefundRequestConfig {
  readonly requests: RefundRequestPort;
  readonly inquiries: CreatorInquiryPort;
  readonly receivables: CreatorReceivablePort;
  readonly policy: RefundPolicyPort;
  readonly orders: OrderRepository;
  readonly refunds: RefundRepository;
  /** このプロセスの環境。⚠️ 要求から受け取らない。 */
  readonly appEnvironment: IntegrationEnvironment;
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
  readonly audit: AuditLogPort;
  readonly logger: Logger;
}

/** 1 件ぶんの詳細。⚠️ 運営の注記と購入者の申し出を混ぜない。 */
export interface RefundRequestDetail {
  readonly request: RefundRequestRecord;
  readonly inquiry: (CreatorInquiryRecord & { readonly expired: boolean }) | null;
  readonly events: readonly RefundRequestEventRecord[];
  readonly remainingAmount: number;
  /** 誰が被るか。⚠️ 事由から決まる（画面で選ばせない）。 */
  readonly clawbackBearer: ClawbackBearer;
}

/** 実行した結果。⚠️ **入金の完了ではない**（事業者が受け付けただけ）。 */
export interface ExecuteRefundRequestResult {
  readonly request: RefundRequestRecord;
  readonly refundId: string;
  readonly amountRefunded: number;
  readonly revokedEntitlements: number;
  readonly cancelledMintJobs: number;
  readonly annotatedMintJobs: number;
}

/** 事実確認 1 件。⚠️ 作家さまへ金額と購入者を見せない。 */
export interface CreatorInquiryView {
  readonly requestId: string;
  readonly orderId: string;
  readonly reason: RefundRequestReason;
  readonly buyerStatement: string | null;
  readonly askedAt: Date;
  readonly dueAt: Date;
  readonly answeredAt: Date | null;
  readonly answer: string | null;
  readonly expired: boolean;
}

const EVENT_LIMIT = 200;

@Injectable()
export class RefundRequestService {
  constructor(
    @Inject(REFUND_REQUEST_CONFIG) private readonly config: RefundRequestConfig,
    /**
     * 決済事業者へ投げる側。
     *
     * ⚠️ **返金の実行はこちらへ委ねる。** 同じ処理を 2 つ持つと、
     * 片方だけ直したときに在庫の戻しや受取権の取り消しが食い違う。
     */
    private readonly refundService: RefundService,
    /**
     * 知らせ（方針整理 2026-08-22）。
     *
     * ⚠️ **例外を投げない実装を渡す。** 知らせが積めないことで、審査の
     * 手続きそのものを巻き戻さない。届かない知らせは運用で拾える。
     */
    private readonly notifier: BuyerNotifier = NULL_NOTIFIER,
  ) {}

  /* --- 読む ------------------------------------------------------------- */

  list(query: {
    readonly limit: number;
    readonly status?: RefundRequestStatus | undefined;
    readonly orderId?: string | undefined;
  }): Promise<readonly RefundRequestRecord[]> {
    return this.config.requests.list(query);
  }

  async detail(id: string): Promise<RefundRequestDetail | null> {
    const request = await this.config.requests.find(id);
    if (request === null) {
      return null;
    }
    const [inquiry, events, context] = await Promise.all([
      this.config.inquiries.findByRequest(id),
      this.config.requests.listEvents(id, EVENT_LIMIT),
      this.config.refunds.loadContext(request.orderId),
    ]);
    const now = this.config.clock.now();
    return {
      request,
      inquiry:
        inquiry === null
          ? null
          : {
              ...inquiry,
              expired: creatorInquiryExpired({
                dueAt: inquiry.dueAt,
                answeredAt: inquiry.answeredAt,
                now,
              }),
            },
      events,
      /*
        ⚠️ **残額は注文から取り直す。** 申請へ焼き付けた額をそのまま出すと、
           別の返金が先に通ったときに、承認の画面が古い残額を出す。
      */
      remainingAmount: context === null ? 0 : context.totalAmount - context.amountRefunded,
      /*
        ⚠️ **保存した値ではなく、そのつど出す。** 申請の段階では、まだ
           「例外として通すか」が決まっていない。承認のときに確定する。
      */
      clawbackBearer: clawbackBearerFor({
        reason: request.reason,
        approvedAsException: request.approvedAsException,
      }),
    };
  }

  /* --- 申し出る --------------------------------------------------------- */

  /**
   * 購入者からの申し出。
   *
   * ⚠️ **ご自分の注文だけ。** 注文の持ち主と突き合わせる。
   * ⚠️ **原則対象外の事由でも受け付ける。** 受け付けないと、その申し出が
   * どれだけ来ているかが記録に残らない。既定では却下されるだけである。
   */
  async submitByBuyer(input: {
    readonly orderId: string;
    readonly accountId: string;
    readonly reason: RefundRequestReason;
    readonly statement: string;
  }): Promise<RefundRequestRecord> {
    if (!isBuyerSelectableReason(input.reason)) {
      /*
        ⚠️ **購入者には分からないことを、選ばせない。** チャージバックは
           事業者から届く事実であり、不正利用や渡し違いは運営の判断である。
      */
      throw new DomainErrorException('REFUND_REQUEST_INVALID');
    }
    const order = await this.config.orders.findById(input.orderId);
    if (order === null || order.accountId !== input.accountId) {
      // ⚠️ 「他人の注文だ」と教えない。無いのと同じ扱いにする。
      throw new NotFoundException();
    }
    return this.open({
      orderId: input.orderId,
      reason: input.reason,
      requestedByAccountId: input.accountId,
      buyerStatement: input.statement,
      actorAccountId: input.accountId,
      openedBy: 'buyer',
    });
  }

  /**
   * 運営が代理で起こす（電話・メールで受けたとき）。
   *
   * ⚠️ **申し出た人を運営にしない。** `requestedByAccountId` には
   * 押した運営を入れる——**二重承認で「別の人」を要求するため**である。
   */
  async openByOperator(input: {
    readonly orderId: string;
    readonly reason: RefundRequestReason;
    readonly statement: string | null;
    readonly note: string | null;
    readonly actorAccountId: string;
  }): Promise<RefundRequestRecord> {
    const order = await this.config.orders.findById(input.orderId);
    if (order === null) {
      throw new NotFoundException();
    }
    return this.open({
      orderId: input.orderId,
      reason: input.reason,
      requestedByAccountId: input.actorAccountId,
      buyerStatement: input.statement,
      note: input.note,
      actorAccountId: input.actorAccountId,
      openedBy: 'operator',
    });
  }

  private async open(input: {
    readonly orderId: string;
    readonly reason: RefundRequestReason;
    readonly requestedByAccountId: string;
    readonly buyerStatement: string | null;
    readonly note?: string | null;
    readonly actorAccountId: string;
    readonly openedBy: 'buyer' | 'operator';
  }): Promise<RefundRequestRecord> {
    const now = this.config.clock.now();

    /*
      ⚠️ **同じ注文に、決着していない申請を 2 つ作らせない。** 作れると、
         2 つとも承認されて二重に返金できる。DB の部分 UNIQUE も同じことを
         止めるが、こちらのほうが読める符号を返せる。
    */
    const open = await this.config.requests.findOpenByOrder(input.orderId);
    if (open !== null) {
      throw new DomainErrorException('REFUND_REQUEST_ALREADY_OPEN');
    }

    const context = await this.config.refunds.loadContext(input.orderId);
    if (context === null) {
      throw new NotFoundException();
    }
    const remaining = context.totalAmount - context.amountRefunded;
    const check = checkRefundAmount({
      /*
        ⚠️ **申し出の時点では全額で置く。** 購入者から額を受け取らない
           （受け取ると、その額が約束に見える）。一部にするかは審査が決める。
      */
      amount: remaining,
      orderTotal: context.totalAmount,
      alreadyRefunded: context.amountRefunded,
    });
    if (!check.ok) {
      throw new DomainErrorException('REFUND_ALREADY_DONE');
    }

    const category = categoryOf(input.reason);
    const request = await this.config.requests.create({
      id: this.config.ids.generate(),
      orderId: input.orderId,
      reason: input.reason,
      category,
      amount: remaining,
      isFullRefund: check.isFullRefund,
      /*
        ⚠️ **提案であって決定ではない。** 承認のときに運営が指定し直す。
           一部返金では、どのシリアルを取り消すべきかを機械に決められない。
      */
      entitlementDisposition: suggestDisposition({
        entitlementStatus: context.entitlementStatus,
        mintStatus: context.mintStatus,
        isFullRefund: check.isFullRefund,
      }),
      requestedByAccountId: input.requestedByAccountId,
      buyerStatement: input.buyerStatement,
      status: 'submitted',
      now,
    });

    await this.record(request.id, 'refund_request.opened', input.actorAccountId, {
      openedBy: input.openedBy,
      reason: input.reason,
      category,
      amount: remaining,
      // ⚠️ 申し出の本文は写さない（証跡は長く残り、閲覧範囲も広い）。
      hasStatement: input.buyerStatement !== null,
    });

    /*
      お受けしたことをお知らせする。

      ⚠️ **「ご返金します」と読める文面にしない。** お受けしたことと、
         お返しすることは別である（文面の語彙に金額を入れていない）。
      ⚠️ **運営が代理で起こしたときも送る。** お電話で受けた方にも、
         受け付いた記録が手元に残るほうがよい。
    */
    await this.notifier.refundRequestReceived({
      requestId: request.id,
      accountId: context.accountId,
      orderId: input.orderId,
      orderNumber: context.orderNumber,
    });

    if (input.note !== undefined && input.note !== null && input.note !== '') {
      await this.config.requests.transition({
        id: request.id,
        from: ['submitted'],
        to: 'submitted',
        patch: { note: input.note },
        now,
      });
    }

    return (await this.config.requests.find(request.id)) ?? request;
  }

  /* --- 調べる ----------------------------------------------------------- */

  /**
   * 作家さまへ事実確認を依頼する。
   *
   * ⚠️ **期限を画面から受け取らない。** 設定の営業日数から決める。
   * ⚠️ **答えを待たない仕掛けにする。** 期限が来れば運営だけで進める
   * （`creatorInquiryExpired`）。答えない作家さまがいるだけで購入者が
   * 待たされる、という形にしない。
   */
  async askCreator(input: {
    readonly id: string;
    readonly note: string | null;
    readonly actorAccountId: string;
  }): Promise<RefundRequestRecord> {
    const now = this.config.clock.now();
    const request = await this.findOrThrow(input.id);

    if (!needsCreatorConfirmation(request.reason)) {
      /*
        ⚠️ **区分で断る。** 事実を知っているのが作家さまだけ、という事由の
           ときにだけ聞く。何でも聞けるようにすると、運営の判断で済む話まで
           作家さまの手を止める。
      */
      throw new DomainErrorException('REFUND_REQUEST_NOT_ACTIONABLE');
    }

    const order = await this.config.orders.findById(request.orderId);
    if (order === null) {
      throw new NotFoundException();
    }

    const policy = await this.loadPolicyOrThrow();
    const moved = await this.config.requests.transition({
      id: request.id,
      from: ['submitted'],
      to: 'creator_review',
      patch: {
        reviewedByAccountId: input.actorAccountId,
        ...(input.note === null ? {} : { note: input.note }),
      },
      now,
    });
    if (!moved) {
      throw new DomainErrorException('REFUND_REQUEST_NOT_ACTIONABLE');
    }

    const dueAt = addBusinessDays(now, policy.creatorInquiryBusinessDays);
    await this.config.inquiries.ask({
      id: this.config.ids.generate(),
      requestId: request.id,
      creatorAccountId: order.creatorAccountId,
      dueAt,
      now,
    });
    await this.record(request.id, 'refund_request.creator_asked', input.actorAccountId, {
      creatorAccountId: order.creatorAccountId,
      dueAt: dueAt.toISOString(),
      businessDays: policy.creatorInquiryBusinessDays,
    });

    /*
      作家さまへお願いする。

      ⚠️ **これが無いと、期限が意味を持たない。** ログインしない限り依頼が
         来たことに気づけないまま期限が過ぎ、運営が「回答が無いので進めた」と
         記録する——作家さまから見れば、聞かれてすらいない。
      ⚠️ **金額と購入者を渡さない。** 事実をお答えいただくのに要らない。
    */
    await this.notifier.refundInquiryAsked({
      requestId: request.id,
      creatorAccountId: order.creatorAccountId,
      dueAt,
    });

    return this.findOrThrow(request.id);
  }

  /**
   * 調べ終えた、という記録。
   *
   * ⚠️ **承認ではない。** ここで進むのは `reviewed` までで、返すと決めるのは
   * `approve`（オーナー限定）である。
   *
   * ⚠️ **作家さまの回答を待たずに進められる。** 期限の意味はそこにある。
   */
  async investigate(input: {
    readonly id: string;
    readonly note: string;
    readonly actorAccountId: string;
  }): Promise<RefundRequestRecord> {
    const now = this.config.clock.now();
    const request = await this.findOrThrow(input.id);

    const inquiry = await this.config.inquiries.findByRequest(request.id);
    const waitedForCreator =
      inquiry === null
        ? null
        : inquiry.answeredAt !== null
          ? 'answered'
          : creatorInquiryExpired({ dueAt: inquiry.dueAt, answeredAt: null, now })
            ? 'expired'
            : 'pending';

    const moved = await this.config.requests.transition({
      id: request.id,
      from: ['submitted', 'creator_review'],
      to: 'reviewed',
      patch: { reviewedByAccountId: input.actorAccountId, note: input.note },
      now,
    });
    if (!moved) {
      throw new DomainErrorException('REFUND_REQUEST_NOT_ACTIONABLE');
    }

    await this.record(request.id, 'refund_request.reviewed', input.actorAccountId, {
      // ⚠️ 「作家さまの回答を待たずに進めた」を残す。あとから問われる。
      creatorInquiry: waitedForCreator,
    });
    return this.findOrThrow(request.id);
  }

  /* --- 決める ----------------------------------------------------------- */

  /**
   * 承認する。
   *
   * ⚠️ **金額をもう一度打っていただく。** 画面に出ている額をそのまま通す
   * のではなく、**打ち直して一致したときだけ**進む。一部返金の金額を
   * 受け取る口を開けた代わりの歯止めである。
   *
   * ⚠️ **二重承認では、申請した本人は承認できない。** 承認の欄が 1 つ
   * 増えただけでは歯止めにならない（DB の CHECK も同じことを止める）。
   */
  async approve(input: {
    readonly id: string;
    readonly amount: number;
    readonly entitlementDisposition: EntitlementDisposition;
    readonly approveAsException: boolean;
    readonly note: string | null;
    readonly actorAccountId: string;
  }): Promise<RefundRequestRecord> {
    const now = this.config.clock.now();
    const request = await this.findOrThrow(input.id);

    if (isExcludedByDefault(request.reason) && !input.approveAsException) {
      /*
        ⚠️ **押し慣れで越えられるようにしない。** 原則対象外の事由は、
           例外として通すと明示したときだけ進む。画面は必ず 1 度断る。
      */
      throw new DomainErrorException('REFUND_REQUEST_NOT_ACTIONABLE');
    }

    const context = await this.config.refunds.loadContext(request.orderId);
    if (context === null) {
      throw new NotFoundException();
    }
    const check = checkRefundAmount({
      amount: input.amount,
      orderTotal: context.totalAmount,
      alreadyRefunded: context.amountRefunded,
    });
    if (!check.ok) {
      throw new DomainErrorException('REFUND_AMOUNT_INVALID');
    }

    const policy = await this.loadPolicyOrThrow();
    const dualApprovalRequired = requiresDualApproval({
      amount: input.amount,
      thresholdAmount: policy.dualApprovalThresholdAmount,
    });

    const decision = canApprove({
      status: request.status,
      requestedByAccountId: request.requestedByAccountId,
      approverAccountId: input.actorAccountId,
      dualApprovalRequired,
    });
    if (!decision.ok) {
      throw new DomainErrorException(
        decision.reason === 'same_person'
          ? 'REFUND_REQUEST_SAME_PERSON'
          : 'REFUND_REQUEST_NOT_ACTIONABLE',
      );
    }

    /*
      ⚠️ **1 人目は `approval_pending` まで。** 2 人目が押して初めて
         `approved` になる。1 人目と 2 人目が同じ人でないことは、
         `canApprove`（申請者との別人）と、下の「1 人目とは別人」の
         両方で見る。
    */
    const firstApproval = dualApprovalRequired && request.status === 'reviewed';
    if (
      dualApprovalRequired &&
      request.status === 'approval_pending' &&
      request.approvedByAccountId === input.actorAccountId
    ) {
      throw new DomainErrorException('REFUND_REQUEST_SAME_PERSON');
    }

    const moved = await this.config.requests.transition({
      id: request.id,
      from: firstApproval ? ['reviewed'] : ['reviewed', 'approval_pending'],
      to: firstApproval ? 'approval_pending' : 'approved',
      patch: {
        approvedByAccountId: input.actorAccountId,
        dualApprovalRequired,
        approvedAsException: input.approveAsException,
        entitlementDisposition: input.entitlementDisposition,
        amount: input.amount,
        isFullRefund: check.isFullRefund,
        ...(input.note === null ? {} : { note: input.note }),
      },
      now,
    });
    if (!moved) {
      throw new DomainErrorException('REFUND_REQUEST_NOT_ACTIONABLE');
    }

    await this.record(request.id, 'refund_request.approved', input.actorAccountId, {
      amount: input.amount,
      isFullRefund: check.isFullRefund,
      entitlementDisposition: input.entitlementDisposition,
      dualApprovalRequired,
      stage: firstApproval ? 'first' : 'final',
      approvedAsException: input.approveAsException,
    });
    await this.config.audit.record({
      actorAccountId: input.actorAccountId,
      action: 'refund_request.approve',
      targetType: 'refund_request',
      targetId: request.id,
      summary: {
        orderId: request.orderId,
        amount: input.amount,
        stage: firstApproval ? 'first' : 'final',
        dualApprovalRequired,
      },
    });

    return this.findOrThrow(request.id);
  }

  /** 却下する。⚠️ 理由が必ず残る（DB の CHECK も空を拒む）。 */
  async reject(input: {
    readonly id: string;
    readonly rejectionNote: string;
    readonly actorAccountId: string;
  }): Promise<RefundRequestRecord> {
    const now = this.config.clock.now();
    const request = await this.findOrThrow(input.id);

    const moved = await this.config.requests.transition({
      id: request.id,
      /*
        ⚠️ **承認済み（`approved`）からは却下させない。** 承認と却下が
           両方立った申請は、あとから読んで意味が取れない。取り消したい
           ときは、承認のやり直しではなく**実行しない**という運用にする。
      */
      from: ['submitted', 'creator_review', 'reviewed', 'approval_pending'],
      to: 'rejected',
      patch: { rejectionNote: input.rejectionNote, reviewedByAccountId: input.actorAccountId },
      now,
    });
    if (!moved) {
      throw new DomainErrorException('REFUND_REQUEST_NOT_ACTIONABLE');
    }

    await this.record(request.id, 'refund_request.rejected', input.actorAccountId, {
      reason: request.reason,
      category: request.category,
    });

    /*
      お断りしたことをお知らせする。

      ⚠️ **黙って終わらせない。** 申し出た方から見ると、返事が来ないのと
         断られたのは違う。返事が来なければ、何度でも問い合わせが来る。
      ⚠️ **却下の理由を渡さない。** 運営の記録は運営の言葉で書かれていて、
         そのままお送りする文ではない。
    */
    const rejectContext = await this.config.refunds.loadContext(request.orderId);
    if (rejectContext !== null) {
      await this.notifier.refundRequestRejected({
        requestId: request.id,
        accountId: rejectContext.accountId,
        orderNumber: rejectContext.orderNumber,
      });
    }
    await this.config.audit.record({
      actorAccountId: input.actorAccountId,
      action: 'refund_request.reject',
      targetType: 'refund_request',
      targetId: request.id,
      // ⚠️ 却下の文面は写さない。読める人の範囲が違う。
      summary: { orderId: request.orderId, reason: request.reason },
    });
    return this.findOrThrow(request.id);
  }

  /* --- 実行する --------------------------------------------------------- */

  /**
   * 決済事業者へ投げる。
   *
   * ⚠️ **`executing` を条件付き更新で取ってから投げる。** 取れなかった
   * ほうは投げない。2 回押されても 1 回しか投げない、という歯止めがここ。
   *
   * ⚠️ **投げたあとに落ちても、`executing` のまま残る。** そのときは
   * 事業者側を確かめてから手当てする。**押し直しで再送させない**
   * （`execution_failed` になったものだけが再実行できる）。
   */
  async execute(input: {
    readonly id: string;
    readonly actorAccountId: string;
  }): Promise<ExecuteRefundRequestResult> {
    const now = this.config.clock.now();
    const request = await this.findOrThrow(input.id);

    const claimed = await this.config.requests.transition({
      id: request.id,
      from: ['approved', 'execution_failed'],
      to: 'executing',
      now,
    });
    if (!claimed) {
      throw new DomainErrorException('REFUND_REQUEST_NOT_ACTIONABLE');
    }
    await this.record(request.id, 'refund_request.executing', input.actorAccountId, {
      amount: request.amount,
    });

    try {
      const outcome = await this.refundService.refundByAdmin({
        orderId: request.orderId,
        /*
          ⚠️ **事業者へ渡す事由は 3 値のほう。** 審査の 15 事由をそのまま
             渡さない——あちらは事業者の語彙で、こちらは運営の語彙である。
        */
        reason: gatewayReasonOf(request.reason),
        actorAccountId: input.actorAccountId,
        // ⚠️ 発行が進んでいても進める。承認がその判断を済ませている。
        acknowledgeIssued: true,
        note: `refund_request:${request.id}`,
        amount: request.amount,
        entitlementDisposition: request.entitlementDisposition,
        /*
          誰が被るか（決定 2026-08-22）。
          ⚠️ **承認の内容から決める。** 事由だけで引き直すと、運営が
             例外として通した判断（`approvedAsException`）がここで消え、
             運営の親切の代金を作家さまが払うことになる。
        */
        clawbackBearer: clawbackBearerFor({
          reason: request.reason,
          approvedAsException: request.approvedAsException,
        }),
      });

      await this.config.requests.transition({
        id: request.id,
        from: ['executing'],
        to: 'executed',
        patch: { refundId: outcome.refund.id },
        now: this.config.clock.now(),
      });
      await this.record(request.id, 'refund_request.executed', input.actorAccountId, {
        refundId: outcome.refund.id,
        amount: outcome.refund.amount,
      });

      return {
        request: await this.findOrThrow(request.id),
        refundId: outcome.refund.id,
        amountRefunded: outcome.settlement.amountRefunded,
        revokedEntitlements: outcome.settlement.revokedEntitlements,
        cancelledMintJobs: outcome.settlement.cancelledMintJobs,
        annotatedMintJobs: outcome.settlement.annotatedMintJobs,
      };
    } catch (error) {
      /*
        ⚠️ **`execution_failed` へ戻すのは、投げられなかったときだけ。**
           投げたあとの失敗（応答が返らない等）をここで拾うと、再実行で
           二重返金になる。`RefundService` は投げる前に記録を残すので、
           運用は `requested` のまま残った返金の行から確かめられる。
      */
      await this.config.requests.transition({
        id: request.id,
        from: ['executing'],
        to: 'execution_failed',
        now: this.config.clock.now(),
      });
      await this.record(request.id, 'refund_request.execution_failed', input.actorAccountId, {
        // ⚠️ 符号だけ。事業者の応答の中身を証跡へ写さない。
        code: error instanceof DomainErrorException ? error.code : 'UNKNOWN',
      });
      throw error;
    }
  }

  /*
    ⚠️ **ここで `creator_receivables` へ自動で積まない**（調査 2026-08-22）。

       既存の精算（`PayoutRepository.listClawbacks`）が、**確定済み・支払済み
       どちらの精算に載っていた注文でも**、あとから返金されたぶんを
       **次の期間の明細で差し引いている**。ここでも積むと、同じ返金を
       二度回収することになる。

       この表が要るのは、その仕組みで**回収しきれない**場合——すでに
       お支払いを済ませた作家さまに、差し引ける次の売上が無いまま
       繰越がマイナスで残り続ける形である。**その回収をどう行うかは
       まだ決まっていない**ので、積む側は配線していない。読む口
       （`listReceivables`）と表だけを用意してある。
  */

  /* --- 作家さま --------------------------------------------------------- */

  /** その方に来ている事実確認。⚠️ 金額と購入者は載せない。 */
  async listInquiriesForCreator(
    creatorAccountId: string,
    limit: number,
  ): Promise<readonly CreatorInquiryView[]> {
    const inquiries = await this.config.inquiries.listForCreator(creatorAccountId, limit);
    const now = this.config.clock.now();
    const views: CreatorInquiryView[] = [];
    for (const inquiry of inquiries) {
      const request = await this.config.requests.find(inquiry.requestId);
      if (request === null) {
        continue;
      }
      views.push({
        requestId: request.id,
        orderId: request.orderId,
        reason: request.reason,
        buyerStatement: request.buyerStatement,
        askedAt: inquiry.askedAt,
        dueAt: inquiry.dueAt,
        answeredAt: inquiry.answeredAt,
        answer: inquiry.answer,
        expired: creatorInquiryExpired({
          dueAt: inquiry.dueAt,
          answeredAt: inquiry.answeredAt,
          now,
        }),
      });
    }
    return views;
  }

  /**
   * 作家さまが答える。
   *
   * ⚠️ **期限を過ぎても受け付ける。** 遅れて届いた事実にも値打ちがある。
   * 期限の意味は「待たずに進めてよい」であって「もう聞かない」ではない。
   *
   * ⚠️ **答えても申請の状態は動かさない。** 進めるのは運営（`investigate`）
   * である。回答で自動的に進むと、読まれないまま次へ行く。
   */
  async answerAsCreator(input: {
    readonly requestId: string;
    readonly creatorAccountId: string;
    readonly answer: string;
    readonly attachmentKeys: readonly string[];
  }): Promise<void> {
    const now = this.config.clock.now();
    const accepted = await this.config.inquiries.answer({
      requestId: input.requestId,
      creatorAccountId: input.creatorAccountId,
      answer: input.answer,
      attachmentKeys: input.attachmentKeys,
      now,
    });
    if (!accepted) {
      /*
        ⚠️ **「もう答えている」と「あなた宛てではない」を分けていない。**
           分けると、別の方宛ての依頼があることを教えてしまう。
      */
      throw new DomainErrorException('REFUND_REQUEST_NOT_ACTIONABLE');
    }
    await this.record(input.requestId, 'refund_request.creator_answered', input.creatorAccountId, {
      // ⚠️ 回答の本文は写さない。添付の鍵も写さない。
      attachmentCount: input.attachmentKeys.length,
      answeredAfterDue: await this.answeredAfterDue(input.requestId, now),
    });
  }

  private async answeredAfterDue(requestId: string, now: Date): Promise<boolean> {
    const inquiry = await this.config.inquiries.findByRequest(requestId);
    return inquiry !== null && now.getTime() > inquiry.dueAt.getTime();
  }

  /** 作家さまから戻していただく分。⚠️ 状態だけが動く記録。 */
  async listReceivables(creatorAccountId: string): Promise<{
    readonly items: readonly ReceivableRecord[];
    readonly outstandingAmount: number;
  }> {
    const items = await this.config.receivables.listOutstanding(creatorAccountId);
    return { items, outstandingAmount: outstandingTotal(items) };
  }

  /* --- 中身 ------------------------------------------------------------- */

  private async findOrThrow(id: string): Promise<RefundRequestRecord> {
    const found = await this.config.requests.find(id);
    if (found === null) {
      throw new DomainErrorException('REFUND_REQUEST_INVALID');
    }
    return found;
  }

  private async loadPolicyOrThrow(): Promise<{
    readonly creatorInquiryBusinessDays: number;
    readonly dualApprovalThresholdAmount: number | null;
  }> {
    const policy = await this.config.policy.find(this.config.appEnvironment);
    if (policy === null) {
      /*
        ⚠️ **既定値でそっと動かさない。** しきい値を設定したつもりの配備で
           二重承認が効いていない、という状態を作らない（手数料率で
           同じ形を避けた判断と同じ）。
      */
      throw new DomainErrorException('SETTLEMENT_SETTINGS_MISSING');
    }
    return policy;
  }

  private record(
    requestId: string,
    action: string,
    actorAccountId: string | null,
    summary: Record<string, unknown>,
  ): Promise<void> {
    return this.config.requests.appendEvent({
      id: this.config.ids.generate(),
      requestId,
      action,
      actorAccountId,
      summary,
      now: this.config.clock.now(),
    });
  }
}

/**
 * 審査の事由を、決済事業者へ渡す 3 値へ落とす。
 *
 * ⚠️ **1 対 1 にならない。** 事業者が知りたいのは「こちらの落ち度か、
 * 買い手の申し出か」だけである。15 事由をそのまま渡す口は無い。
 */
function gatewayReasonOf(reason: RefundRequestReason): 'buyer_request' | 'our_fault' {
  switch (reason) {
    case 'duplicate_payment':
    case 'wrong_amount':
    case 'system_failure':
    case 'issuance_failed':
    case 'wrong_grant':
      return 'our_fault';
    default:
      return 'buyer_request';
  }
}
