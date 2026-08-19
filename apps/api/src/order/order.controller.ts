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
  adminOrderListQuerySchema,
  createOrderRequestSchema,
  type AdminOrderListResponse,
  type AdminOrderDetail,
  type CheckoutSessionResponse,
  type OrderView,
} from '@sengoku/contracts';
import { currentRequestId } from '@sengoku/observability';
import type { Actor } from '@sengoku/auth';
import { CurrentActor, RequireAction } from '../auth/auth.guard';
import { parseOrThrow } from '../common/validation';
import { OrderService } from './order.service';
import { CheckoutService } from './checkout.service';

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

/** 運営向けの注文一覧・詳細（指示書 §9.1・§9.2）。 */
@Controller('api/v1/admin/orders')
export class AdminOrderController {
  constructor(private readonly orders: OrderService) {}

  @Get()
  @RequireAction('order.view_any')
  async list(@Query() rawQuery: unknown): Promise<AdminOrderListResponse> {
    const query = parseOrThrow(adminOrderListQuerySchema, rawQuery);
    const page = await this.orders.listForAdmin({
      limit: query.limit,
      cursor: query.cursor,
      status: query.status,
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
