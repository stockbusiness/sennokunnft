import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  adminOrderEmailLookupSchema,
  adminOrderListQuerySchema,
  createOrderNoteRequestSchema,
  createOrderRequestSchema,
  createRefundRequestSchema,
  refundListResponseSchema,
  refundResultSchema,
  type AdminOrderListResponse,
  type AdminOrderDetail,
  type AdminOrderNotesResponse,
  type AdminOrderTimelineResponse,
  type CheckoutSessionResponse,
  type OrderNoteView,
  type OrderView,
  type RefundListResponse,
  type RefundResult,
} from '@sengoku/contracts';
import { currentRequestId } from '@sengoku/observability';
import type { Actor } from '@sengoku/auth';
import { CurrentActor, RequireAction } from '../auth/auth.guard';
import { parseOrThrow } from '../common/validation';
import { OrderService } from './order.service';
import { CheckoutService } from './checkout.service';
import { OrderSupportService } from './order-support.service';
import { RefundService } from './refund.service';

/**
 * 購入者向けの注文。
 *
 * ⚠️ **金額に関わる値を本文から読まない**（指示書 §4.2）。
 * `createOrderRequestSchema` が受け付けるのは出品IDと冪等キーだけで、
 * 契約側で閉じてある。ここへ `@Body()` から別の値を取り出さないこと。
 */
@Controller('api/v1/orders')
export class OrderController {
  constructor(private readonly orders: OrderService) {}

  @Post()
  @RequireAction('order.create')
  async create(
    @CurrentActor() actor: Actor,
    @Body() rawBody: unknown,
  ): Promise<{ readonly order: OrderView; readonly reused: boolean }> {
    const body = parseOrThrow(createOrderRequestSchema, rawBody);
    // ⚠️ 購入者は**トークンから**取る。本文の値は見ない。
    const accountId = requireAccountId(actor);
    return this.orders.create({
      accountId,
      listingId: body.listingId,
      idempotencyKey: body.idempotencyKey,
    });
  }

  @Get(':id')
  @RequireAction('order.view')
  async detail(@CurrentActor() actor: Actor, @Param('id') id: string): Promise<OrderView> {
    const accountId = requireAccountId(actor);
    const order = await this.orders.findForBuyer(id, accountId);
    if (order === null) {
      // ⚠️ 他人の注文と存在しない注文を区別しない。
      //    区別すると、注文IDの総当たりで存在を確かめられる。
      throw new NotFoundException();
    }
    return order;
  }
}

/**
 * 支払いの口を作る（指示書 §5.2）。
 *
 * ⚠️ **決済の設定が無い環境では、この経路ごと生えない。** 押しても
 * 500 になるボタンを画面に出さないため、`AppModule` が登録を分けている。
 */
@Controller('api/v1/orders')
export class CheckoutController {
  constructor(private readonly checkout: CheckoutService) {}

  /**
   * ⚠️ **本文を受け取らない。** 金額も通貨も注文から引く。
   * ここに `@Body()` を足した瞬間、ブラウザから金額を送れる道ができる。
   */
  @Post(':id/checkout-session')
  @RequireAction('checkout.create')
  @HttpCode(HttpStatus.CREATED)
  createCheckoutSession(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
  ): Promise<CheckoutSessionResponse> {
    return this.checkout.create({
      orderId: id,
      // ⚠️ 購入者はトークンから取る。本文からは受け取らない。
      accountId: requireAccountId(actor),
      correlationId: currentRequestId() ?? null,
    });
  }
}

/** 運営向けの注文一覧・詳細（指示書 §9.1・§9.2 と `UD-121`）。 */
@Controller('api/v1/admin/orders')
export class AdminOrderController {
  constructor(
    private readonly orders: OrderService,
    private readonly support: OrderSupportService,
    private readonly refunds: RefundService,
  ) {}

  /**
   * 一覧と検索（`UD-121`）。
   *
   * ⚠️ **メールアドレスをここで受け取らない。** 問い合わせ文字列は
   * アクセスログ・ブラウザ履歴・共有されたリンクに残る。
   * メールからの照合は下の `POST search` が担う。
   */
  @Get()
  @RequireAction('order.view_any')
  async list(@Query() rawQuery: unknown): Promise<AdminOrderListResponse> {
    const query = parseOrThrow(adminOrderListQuerySchema, rawQuery);
    const criteria = this.support.normalizeSearch({
      status: query.status,
      paymentStatus: query.paymentStatus,
      orderNumber: query.orderNumber,
      // ⚠️ 日付のまま渡す。その日の始まり／終わりへの読み替えは
      //    ドメインが行う（JST で区切る。`normalizeOrderSearch`）。
      createdFrom: query.createdFrom,
      createdTo: query.createdTo,
      minTotalAmount: query.minTotalAmount,
      maxTotalAmount: query.maxTotalAmount,
      artworkTitle: query.artworkTitle,
    });
    const page = await this.orders.listForAdmin({
      limit: query.limit,
      cursor: query.cursor,
      criteria,
    });
    return { items: [...page.items], nextCursor: page.nextCursor };
  }

  /**
   * 聞き取ったメールアドレスから注文を辿る（`UD-121`）。
   *
   * ⚠️ **`POST` なのは、本文に入れて URL へ残さないため。** 副作用は
   * 監査ログの 1 行だけで、注文は何も変わらない。
   * ⚠️ **平文はここから先へ渡らない。** 照合値へ変換し、平文は捨てる。
   * ⚠️ **`order.view_any` とは別の権限**（`order.lookup_buyer`）。
   * 一覧を見ることと、人に紐づけて注文の有無を答えられることは別。
   */
  @Post('search')
  @RequireAction('order.lookup_buyer')
  @HttpCode(HttpStatus.OK)
  async searchByEmail(
    @CurrentActor() actor: Actor,
    @Body() rawBody: unknown,
  ): Promise<AdminOrderListResponse> {
    const body = parseOrThrow(adminOrderEmailLookupSchema, rawBody);
    // ⚠️ 鍵の無い配備ではここで `EMAIL_LOOKUP_UNAVAILABLE` になる。
    //    「見つからない」に丸めない。
    const emailHash = this.support.hashEmailForLookup(body.email);
    const criteria = this.support.normalizeSearch({ emailHash });
    const page = await this.orders.listForAdmin({
      limit: body.limit,
      cursor: body.cursor,
      criteria,
    });
    await this.support.recordEmailLookup({
      actorAccountId: requireAccountId(actor),
      matchedCount: page.items.length,
    });
    return { items: [...page.items], nextCursor: page.nextCursor };
  }

  @Get(':id')
  @RequireAction('order.view_any')
  async detail(@Param('id') id: string): Promise<AdminOrderDetail> {
    const order = await this.orders.findForAdmin(id);
    if (order === null) {
      throw new NotFoundException();
    }
    return order;
  }

  /** 注文の経過（`UD-121`）。⚠️ 古い順。決済の試行と受信記録を 1 列にする。 */
  @Get(':id/timeline')
  @RequireAction('order.view_any')
  async timeline(@Param('id') id: string): Promise<AdminOrderTimelineResponse> {
    const timeline = await this.support.timeline(id);
    if (timeline === null) {
      throw new NotFoundException();
    }
    return timeline;
  }

  @Get(':id/notes')
  @RequireAction('order.view_any')
  async notes(@Param('id') id: string): Promise<AdminOrderNotesResponse> {
    const notes = await this.support.listNotes(id);
    if (notes === null) {
      throw new NotFoundException();
    }
    return notes;
  }

  /**
   * 対応メモを足す（`UD-121`）。
   *
   * ⚠️ **更新と削除の口を作らない。** 追記のみ。書き間違えたら
   * 訂正のメモを足す。
   */
  @Post(':id/notes')
  @RequireAction('order.note')
  @HttpCode(HttpStatus.CREATED)
  async addNote(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() rawBody: unknown,
  ): Promise<OrderNoteView> {
    const body = parseOrThrow(createOrderNoteRequestSchema, rawBody);
    const note = await this.support.addNote({
      orderId: id,
      // ⚠️ 書いた人はトークンから取る。本文からは受け取らない。
      authorAccountId: requireAccountId(actor),
      body: body.body,
    });
    if (note === null) {
      throw new NotFoundException();
    }
    return note;
  }

  /**
   * その注文の返金の記録（`UD-120`）。
   *
   * ⚠️ **`auditor` にも開く**（`order.view_any`）。返金が見えないと監査に
   * ならない。動かすこと（`order.refund`）とは別の力として分けてある。
   */
  @Get(':id/refunds')
  @RequireAction('order.view_any')
  async listRefunds(@Param('id') id: string): Promise<RefundListResponse> {
    const items = await this.refunds.listByOrder(id);
    return parseOrThrow(refundListResponseSchema, {
      items: items.map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
        settledAt: row.settledAt?.toISOString() ?? null,
      })),
    });
  }

  /**
   * 返金する（`UD-104` / `UD-120`）。
   *
   * ⚠️ **金額を本文から読まない。** 返すのは常に残額の全部（一部返金は
   * 自動処理しない決定）。額を受け取る口を作ると、桁を 1 つ多く打った
   * 操作がそのまま通る。
   *
   * ⚠️ **成功しても「返金しました」で終わらせない。** 取り消せなかった
   * 発行ジョブの数まで返す。丸めると、運営は片づいたと思って画面を閉じる。
   */
  @Post(':id/refund')
  @RequireAction('order.refund')
  @HttpCode(HttpStatus.CREATED)
  async refund(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() rawBody: unknown,
  ): Promise<RefundResult> {
    const body = parseOrThrow(createRefundRequestSchema, rawBody);
    const outcome = await this.refunds.refundByAdmin({
      orderId: id,
      reason: body.reason,
      // ⚠️ 誰が返金したかはトークンから取る。本文からは受け取らない。
      actorAccountId: requireAccountId(actor),
      acknowledgeIssued: body.acknowledgeIssued ?? false,
      note: body.note ?? null,
    });
    return parseOrThrow(refundResultSchema, {
      refund: {
        ...outcome.refund,
        createdAt: outcome.refund.createdAt.toISOString(),
        settledAt: outcome.refund.settledAt?.toISOString() ?? null,
      },
      refundStatus: outcome.settlement.refundStatus,
      amountRefunded: outcome.settlement.amountRefunded,
      revokedEntitlements: outcome.settlement.revokedEntitlements,
      cancelledMintJobs: outcome.settlement.cancelledMintJobs,
      annotatedMintJobs: outcome.settlement.annotatedMintJobs,
      restoredSupply: outcome.settlement.restoredSupply,
    });
  }
}

/**
 * ⚠️ **状態を書き換える管理APIをここへ足さない**（指示書 §9.3）。
 * 金額の書換え・`paid` への手動変更・在庫と無関係な予約作成・
 * 注文の物理削除は作らない。決済の確定は Webhook だけが行う（Phase P2）。
 */

function requireAccountId(actor: Actor): string {
  if (actor.accountId === null || actor.accountId === undefined) {
    // ガードが通しているので通常は来ない。来たら開かない側へ倒す。
    throw new ForbiddenException();
  }
  return actor.accountId;
}
