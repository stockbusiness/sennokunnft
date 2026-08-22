import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  adminRefundRequestDetailSchema,
  answerRefundInquirySchema,
  approveRefundRequestSchema,
  askCreatorSchema,
  creatorRefundInquiryListResponseSchema,
  creatorReceivableListResponseSchema,
  executeRefundRequestResponseSchema,
  investigateRefundRequestSchema,
  openRefundRequestSchema,
  refundRequestListQuerySchema,
  refundRequestListResponseSchema,
  refundRequestSchema,
  rejectRefundRequestSchema,
  submitRefundRequestSchema,
  type AdminRefundRequestDetail,
  type CreatorReceivableListResponse,
  type CreatorRefundInquiryListResponse,
  type ExecuteRefundRequestResponse,
  type RefundRequestListResponse,
  type RefundRequestViewDto,
} from '@sengoku/contracts';
import type { Actor } from '@sengoku/auth';
import type { RefundRequestRecord } from '@sengoku/domain';
import { CurrentActor, RequireAction } from '../auth/auth.guard';
import { parseOrThrow } from '../common/validation';
import { RefundRequestService } from './refund-request.service';

/**
 * 返金の申請と審査 — 運営（方針整理 2026-08-22）。
 *
 * ⚠️ **調べる口と、返すと決める口を分けてある。**
 * `investigate` / `ask-creator` は運営担当者（`refund_request.investigate`）、
 * `approve` / `reject` / `execute` はオーナー（`refund_request.approve`）。
 * 1 つの門にまとめると、調べた人がそのまま返せてしまう。
 *
 * ⚠️ **`auditor` は読むだけ。** 誰が申し出て誰が承認したかは監査の対象
 * そのものなので、`refund_request.view` は渡してある。
 */
@Controller('api/v1/admin/refund-requests')
export class AdminRefundRequestController {
  constructor(private readonly requests: RefundRequestService) {}

  @Get()
  @RequireAction('refund_request.view')
  async list(@Query() rawQuery: Record<string, unknown>): Promise<RefundRequestListResponse> {
    const query = parseOrThrow(refundRequestListQuerySchema, rawQuery);
    const items = await this.requests.list(query);
    return parseOrThrow(refundRequestListResponseSchema, { items: items.map(toDto) });
  }

  @Get(':id')
  @RequireAction('refund_request.view')
  async detail(@Param('id') id: string): Promise<AdminRefundRequestDetail> {
    const found = await this.requests.detail(id);
    if (found === null) {
      throw new NotFoundException();
    }
    return parseOrThrow(adminRefundRequestDetailSchema, {
      request: toDto(found.request),
      note: found.request.note,
      buyerStatement: found.request.buyerStatement,
      inquiry:
        found.inquiry === null
          ? null
          : {
              creatorAccountId: found.inquiry.creatorAccountId,
              askedAt: found.inquiry.askedAt.toISOString(),
              dueAt: found.inquiry.dueAt.toISOString(),
              answeredAt: found.inquiry.answeredAt?.toISOString() ?? null,
              answer: found.inquiry.answer,
              attachmentKeys: [...found.inquiry.attachmentKeys],
              expired: found.inquiry.expired,
            },
      events: found.events.map((event) => ({
        id: event.id,
        action: event.action,
        actorAccountId: event.actorAccountId,
        summary: event.summary,
        createdAt: event.createdAt.toISOString(),
      })),
      remainingAmount: found.remainingAmount,
      // ⚠️ 押す前に、誰が被るかを見せるための値。
      clawbackBearer: found.clawbackBearer,
      clawbackBearerDefault: found.clawbackBearerDefault,
      clawbackBearerOverridden: found.clawbackBearerOverridden,
    });
  }

  /** 運営が代理で起こす。⚠️ 押した運営が「申し出た人」になる（二重承認のため）。 */
  @Post()
  @RequireAction('refund_request.investigate')
  async open(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<RefundRequestViewDto> {
    const input = parseOrThrow(openRefundRequestSchema, body);
    const created = await this.requests.openByOperator({
      orderId: input.orderId,
      reason: input.reason,
      statement: input.statement ?? null,
      note: input.note ?? null,
      actorAccountId: requireAccountId(actor),
    });
    return parseOrThrow(refundRequestSchema, toDto(created));
  }

  /**
   * 作家さまへ事実確認を依頼する。
   *
   * ⚠️ **期限を本文で受け取らない。** 設定の営業日数から決める。
   */
  @Post(':id/ask-creator')
  @RequireAction('refund_request.investigate')
  async askCreator(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<RefundRequestViewDto> {
    const input = parseOrThrow(askCreatorSchema, body);
    const updated = await this.requests.askCreator({
      id,
      note: input.note ?? null,
      actorAccountId: requireAccountId(actor),
    });
    return parseOrThrow(refundRequestSchema, toDto(updated));
  }

  /** 調べ終えた。⚠️ 承認ではない。 */
  @Post(':id/investigate')
  @RequireAction('refund_request.investigate')
  async investigate(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<RefundRequestViewDto> {
    const input = parseOrThrow(investigateRefundRequestSchema, body);
    const updated = await this.requests.investigate({
      id,
      note: input.note,
      actorAccountId: requireAccountId(actor),
    });
    return parseOrThrow(refundRequestSchema, toDto(updated));
  }

  /**
   * 承認する。
   *
   * ⚠️ **オーナー限定**（`refund_request.approve` は `OWNER_ONLY_ACTIONS`）。
   * ⚠️ **金額をもう一度打っていただく。** 一部返金の額を受け取る口を
   * 開けた代わりの歯止め。
   */
  @Post(':id/approve')
  @RequireAction('refund_request.approve')
  async approve(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<RefundRequestViewDto> {
    const input = parseOrThrow(approveRefundRequestSchema, body);
    const updated = await this.requests.approve({
      id,
      amount: input.amount,
      entitlementDisposition: input.entitlementDisposition,
      approveAsException: input.approveAsException ?? false,
      // ⚠️ 省略なら事由から決まる既定。押した値をそのまま渡す。
      clawbackBearer: input.clawbackBearer ?? null,
      note: input.note ?? null,
      actorAccountId: requireAccountId(actor),
    });
    return parseOrThrow(refundRequestSchema, toDto(updated));
  }

  /** 却下する。⚠️ 理由が必ず残る。 */
  @Post(':id/reject')
  @RequireAction('refund_request.approve')
  async reject(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<RefundRequestViewDto> {
    const input = parseOrThrow(rejectRefundRequestSchema, body);
    const updated = await this.requests.reject({
      id,
      rejectionNote: input.rejectionNote,
      actorAccountId: requireAccountId(actor),
    });
    return parseOrThrow(refundRequestSchema, toDto(updated));
  }

  /**
   * 決済事業者へ投げる。
   *
   * ⚠️ **押し直しで二重に投げない。** `executing` を条件付き更新で取った
   * ほうだけが進む。取れなかった要求は 409 で返る。
   */
  @Post(':id/execute')
  @RequireAction('refund_request.approve')
  async execute(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
  ): Promise<ExecuteRefundRequestResponse> {
    const result = await this.requests.execute({ id, actorAccountId: requireAccountId(actor) });
    return parseOrThrow(executeRefundRequestResponseSchema, {
      request: toDto(result.request),
      refundId: result.refundId,
      amountRefunded: result.amountRefunded,
      revokedEntitlements: result.revokedEntitlements,
      cancelledMintJobs: result.cancelledMintJobs,
      annotatedMintJobs: result.annotatedMintJobs,
    });
  }
}

/**
 * 返金の申請 — 購入者。
 *
 * ⚠️ **ご自分の注文だけ。** 注文の持ち主と突き合わせる。他人の注文は
 * 「無い」と返す（あることを教えない）。
 *
 * ⚠️ **金額を受け取らない。** どれだけ返るかは審査が決める。打てるように
 * すると、その額が約束に見える。
 */
@Controller('api/v1/orders/:orderId/refund-requests')
export class BuyerRefundRequestController {
  constructor(private readonly requests: RefundRequestService) {}

  @Post()
  @RequireAction('order.view')
  async submit(
    @CurrentActor() actor: Actor,
    @Param('orderId') orderId: string,
    @Body() body: unknown,
  ): Promise<RefundRequestViewDto> {
    const input = parseOrThrow(submitRefundRequestSchema, body);
    const created = await this.requests.submitByBuyer({
      orderId,
      accountId: requireAccountId(actor),
      reason: input.reason,
      statement: input.statement,
    });
    return parseOrThrow(refundRequestSchema, toDto(created));
  }
}

/**
 * 事実確認と売上からの戻し — 作家さま。
 *
 * ⚠️ **返金を実行する口は無い。** 作家さまにあるのは「事実確認に答える」
 * だけである。販売の代金は運営の決済アカウントで受けているので、返せるのも
 * 運営だけになる。
 *
 * ⚠️ **「返金してよい / いけない」の欄も無い。** 伺うのは**事実**で、
 * 決めるのは運営である。
 */
@Controller('api/v1/creator')
export class CreatorRefundInquiryController {
  constructor(private readonly requests: RefundRequestService) {}

  @Get('refund-inquiries')
  @RequireAction('refund_inquiry.answer_own')
  async list(@CurrentActor() actor: Actor): Promise<CreatorRefundInquiryListResponse> {
    const items = await this.requests.listInquiriesForCreator(requireAccountId(actor), 50);
    return parseOrThrow(creatorRefundInquiryListResponseSchema, {
      items: items.map((item) => ({
        requestId: item.requestId,
        orderId: item.orderId,
        reason: item.reason,
        buyerStatement: item.buyerStatement,
        askedAt: item.askedAt.toISOString(),
        dueAt: item.dueAt.toISOString(),
        answeredAt: item.answeredAt?.toISOString() ?? null,
        answer: item.answer,
        expired: item.expired,
      })),
    });
  }

  /** ⚠️ **期限を過ぎても受け付ける。** 遅れて届いた事実にも値打ちがある。 */
  @Post('refund-inquiries/:requestId/answer')
  @RequireAction('refund_inquiry.answer_own')
  async answer(
    @CurrentActor() actor: Actor,
    @Param('requestId') requestId: string,
    @Body() body: unknown,
  ): Promise<{ readonly ok: true }> {
    const input = parseOrThrow(answerRefundInquirySchema, body);
    await this.requests.answerAsCreator({
      requestId,
      creatorAccountId: requireAccountId(actor),
      answer: input.answer,
      attachmentKeys: input.attachmentKeys ?? [],
    });
    return { ok: true };
  }

  /**
   * 売上からの戻し。
   *
   * ⚠️ **金額を書き換える口は無い**（`SETTLEMENT_AND_REFUND.md` §4）。
   * 記録であって帳簿ではない。
   */
  @Get('receivables')
  @RequireAction('creator.earnings.view_own')
  async receivables(@CurrentActor() actor: Actor): Promise<CreatorReceivableListResponse> {
    const result = await this.requests.listReceivables(requireAccountId(actor));
    return parseOrThrow(creatorReceivableListResponseSchema, {
      items: result.items.map((item) => ({
        id: item.id,
        orderId: item.orderId,
        amount: item.amount,
        status: item.status,
        createdAt: item.createdAt.toISOString(),
        settledAt: item.settledAt?.toISOString() ?? null,
      })),
      outstandingAmount: result.outstandingAmount,
    });
  }
}

function toDto(request: RefundRequestRecord): RefundRequestViewDto {
  return {
    id: request.id,
    orderId: request.orderId,
    status: request.status,
    reason: request.reason,
    category: request.category,
    amount: request.amount,
    isFullRefund: request.isFullRefund,
    entitlementDisposition: request.entitlementDisposition,
    requestedByAccountId: request.requestedByAccountId,
    reviewedByAccountId: request.reviewedByAccountId,
    approvedByAccountId: request.approvedByAccountId,
    dualApprovalRequired: request.dualApprovalRequired,
    approvedAsException: request.approvedAsException,
    rejectionNote: request.rejectionNote,
    refundId: request.refundId,
    createdAt: request.createdAt.toISOString(),
    updatedAt: request.updatedAt.toISOString(),
  };
}

function requireAccountId(actor: Actor): string {
  if (actor.accountId === null || actor.accountId === undefined) {
    // ガードが通しているので通常は来ない。来たら開かない側へ倒す。
    throw new ForbiddenException();
  }
  return actor.accountId;
}
