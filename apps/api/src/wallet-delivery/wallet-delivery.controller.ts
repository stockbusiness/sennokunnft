import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import type {
  ResendWalletDeliveriesResponse,
  WalletDeliveryListResponse,
  WalletDeliveryView,
} from '@sengoku/contracts';
import { resendWalletDeliveriesRequestSchema } from '@sengoku/contracts';
import type { Actor } from '@sengoku/auth';
import { CurrentActor, RequireAction } from '../auth/auth.guard';
import { parseOrThrow } from '../common/validation';
import { WalletDeliveryAdminService } from './wallet-delivery.service';

/**
 * 送信の運用画面（管理画面・外部連携 指示書 §5・§20）。
 *
 * ⚠️ **本文・API キー・HMAC 署名値・`Authorization` ヘッダーを返す経路が
 * ここに無いことを保つ。** 「調べるのに要る」と言われても足さない。
 * 相手方と突き合わせるのに要るのは `eventId` と `correlationId` の 2 つで、
 * それは返している。
 *
 * ⚠️ **閲覧は `integration.view`、再送は `wallet_delivery.retry`。**
 * 閲覧者（auditor）は状態を見られるが送り直せない。再送は状態を変える操作で、
 * 相手のシステムに実際の通信が飛ぶ。
 *
 * ⚠️ **再送にオーナーの印は要らない。** 運営の日常業務であり、送る内容は
 * すでに行に確定していて、新しく何かを決める操作ではない。
 */
@Controller('api/v1/admin/wallet-deliveries')
export class WalletDeliveryController {
  constructor(private readonly deliveries: WalletDeliveryAdminService) {}

  @Get()
  @RequireAction('integration.view')
  list(
    @Query('status') status?: string | string[],
    @Query('eventId') eventId?: string,
    @Query('entitlementId') entitlementId?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<WalletDeliveryListResponse> {
    return this.deliveries.list({
      // `?status=FAILED&status=DEAD` は配列で、1 つだけなら文字列で届く。
      statuses: status === undefined ? undefined : Array.isArray(status) ? status : [status],
      eventId,
      entitlementId,
      cursor,
      limit: limit === undefined ? undefined : Number.parseInt(limit, 10),
    });
  }

  @Get(':id')
  @RequireAction('integration.view')
  detail(@Param('id') id: string): Promise<WalletDeliveryView> {
    return this.deliveries.detail(id);
  }

  /**
   * 手で送り直す。
   *
   * ⚠️ **本文（POST）で対象を受け取る。** 経路に載せると、リンクを
   * 踏ませるだけで再送させられる。ブラウザが自動で資格情報を付けない
   * 認証方式（`Authorization` ヘッダー）なので実害は小さいが、
   * 「押していないのに送られた」経路を作らない。
   */
  @Post('resend')
  @RequireAction('wallet_delivery.retry')
  resend(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<ResendWalletDeliveriesResponse> {
    return this.deliveries.resend(actor, parseOrThrow(resendWalletDeliveriesRequestSchema, body));
  }
}
