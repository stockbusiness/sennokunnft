import { Body, Controller, Headers, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { z } from '@sengoku/validation';
import type { Actor } from '@sengoku/auth';
import { CurrentActor, RequireAction } from '../auth/auth.guard';
import { IdempotencyService } from '../common/idempotency';
import { parseOrThrow } from '../common/validation';
import { OrderService, type OrderCreated } from './order.service';
import { BadRequestException } from '@nestjs/common';

const createOrderSchema = z.object({
  listing_id: z.string().uuid('出品IDの形式が正しくありません'),
  quantity: z.number().int().min(1),
});

/**
 * 注文 API（方針変更 2026-08-14 §8）。
 *
 * ⚠️ **`@Public()` を付けない。** 購入はログイン必須（`UD-504` 確定）。
 * 所有権の判定は不要（自分の注文を作るだけ）だが、
 * **誰の注文かをサーバー側で決める**。本文の account_id は受け取らない。
 */
@Controller('api/v1/orders')
export class OrderController {
  constructor(
    private readonly orders: OrderService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /**
   * 注文を作成する。
   *
   * ⚠️ **`Idempotency-Key` を必須にする。**
   * 注文は取り返しのつかない操作。応答だけが失われて利用者が
   * 送り直したとき、**二重に注文させない**ためにこれが要る。
   */
  @Post()
  @RequireAction('order.create')
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentActor() actor: Actor,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<OrderCreated> {
    const parsed = parseOrThrow(createOrderSchema, body);
    const key = this.idempotency.normalizeKey(idempotencyKey);
    if (key === null) {
      throw new BadRequestException({
        error: { code: 'VALIDATION_ERROR', message: 'Idempotency-Key ヘッダが必要です。' },
      });
    }
    return this.orders.create({
      actor,
      listingId: parsed.listing_id,
      quantity: parsed.quantity,
      idempotencyKey: key,
    });
  }
}
