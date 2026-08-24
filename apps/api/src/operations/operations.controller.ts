import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import type {
  ConsistencyResponse,
  DisputeAdminListResponse,
  EntitlementAdminDetailView,
  EntitlementAdminListResponse,
  OperationsDashboardResponse,
  RedeliverResponse,
  ReservedCountDriftListResponse,
  ReservedCountRepairAdminView,
  ReservedCountRepairListResponse,
  RetryIssuanceResponse,
} from '@sengoku/contracts';
import {
  disputeAdminQuerySchema,
  entitlementAdminQuerySchema,
  reservedCountDriftQuerySchema,
  reservedCountRepairQuerySchema,
  reservedCountRepairRequestSchema,
  reservedCountRepairResolveRequestSchema,
} from '@sengoku/contracts';
import type { Actor } from '@sengoku/auth';
import { CurrentActor, RequireAction } from '../auth/auth.guard';
import { parseOrThrow } from '../common/validation';
import { OperationsDashboardService } from './dashboard.service';

/**
 * 運営ダッシュボード（実運営 指示書 P0-6）。
 *
 * ⚠️ **見るのと動かすのを分けている。** 一覧と指標は閲覧者にも開くが、
 * やり直し（発行・再配送）は運営だけ。どちらも外部へ実際に送る操作である。
 *
 * ⚠️ **個人を特定できる値を返さない。** 返すのは件数と識別子まで。
 * 契約（zod）に項目そのものが無いので、載せようがない。
 */
@Controller('api/v1/admin/operations')
export class OperationsController {
  constructor(private readonly operations: OperationsDashboardService) {}

  /** 朝いちばんに見る画面。 */
  @Get('dashboard')
  @RequireAction('operations.view')
  dashboard(): Promise<OperationsDashboardResponse> {
    return this.operations.dashboard();
  }

  /**
   * 記録どうしの食い違いを探す。
   *
   * ⚠️ **直さない。数えるだけ。** 黙って直すと、なぜ食い違ったのかが
   * 分からないまま同じことが繰り返される。
   */
  @Get('consistency')
  @RequireAction('operations.view')
  consistency(): Promise<ConsistencyResponse> {
    return this.operations.consistency();
  }

  /**
   * 押さえがずれた作品の一覧（`ADMIN_OPERATIONS_GAP.md` §I・2026-08-23）。
   *
   * ⚠️ **見るのと直すのを分けてある。** 一覧は閲覧者にも開くが、
   * 直すのは `operations.retry` を持つ人だけ。売り越しの芽が残って
   * いないかは監査の対象そのものなので、見る側を狭めない。
   */
  @Get('reserved-count-drift')
  @RequireAction('operations.view')
  listReservedCountDrift(@Query() query: unknown): Promise<ReservedCountDriftListResponse> {
    return this.operations.listReservedCountDrift(
      parseOrThrow(reservedCountDriftQuerySchema, query),
    );
  }

  /**
   * 押さえのずれを 1 件だけ直す（`ADMIN_OPERATIONS_GAP.md` §I・2026-08-24）。
   *
   * ⚠️ **オーナー限定にしていない。** 数を人が選べない（直す先は計算で
   * 出る）ため、手数料率のような「上限の無い操作」ではない。オーナー限定は
   * 一見安全だが、**気づいた人が動けず、待っているあいだ売り越しが続く。**
   *
   * ⚠️ **一括で直す口を作らない。** 作品の識別子を 1 つだけ受ける。
   */
  @Post('reserved-count-drift/:artworkId/repair')
  @RequireAction('operations.retry')
  repairReservedCount(
    @CurrentActor() actor: Actor,
    @Param('artworkId') artworkId: string,
    @Body() body: unknown,
  ): Promise<ReservedCountRepairAdminView> {
    return this.operations.repairReservedCount(
      actor,
      artworkId,
      parseOrThrow(reservedCountRepairRequestSchema, body),
    );
  }

  /**
   * 直した記録の一覧。⚠️ 既定は原因未特定の積み残しのみ。
   *
   * ⚠️ **閲覧者にも開く。** 「直したのに原因を調べていない」ことが
   * 残っているかどうかは、監査の対象そのものである。
   */
  @Get('reserved-count-repairs')
  @RequireAction('operations.view')
  listReservedCountRepairs(@Query() query: unknown): Promise<ReservedCountRepairListResponse> {
    return this.operations.listReservedCountRepairs(
      parseOrThrow(reservedCountRepairQuerySchema, query),
    );
  }

  /**
   * 原因未特定の積み残しを閉じる。
   *
   * ⚠️ **消す操作ではない。** 何が分かったのかを書かせ、記録へ書き足す。
   * 直す前の値と内訳には触らない。
   */
  @Post('reserved-count-repairs/:repairId/resolve')
  @RequireAction('operations.retry')
  resolveReservedCountRepair(
    @CurrentActor() actor: Actor,
    @Param('repairId') repairId: string,
    @Body() body: unknown,
  ): Promise<ReservedCountRepairAdminView> {
    return this.operations.resolveReservedCountRepair(
      actor,
      repairId,
      parseOrThrow(reservedCountRepairResolveRequestSchema, body),
    );
  }

  /**
   * カード会社との争いの一覧（2026-08-22）。
   *
   * ⚠️ **読むだけの口しか作らない。** 証拠の提出も取り下げも決済事業者の
   * 画面で行う。こちらに動かす口を作ると、事業者の記録とこちらの記録が
   * 食い違う——正はあちらにある。
   *
   * ⚠️ **閲覧者にも開く。** 額を動かす操作は無く、取り立て漏れや対応漏れが
   * 残っていないかは監査の対象そのものである。
   */
  @Get('disputes')
  @RequireAction('operations.view')
  listDisputes(@Query() query: unknown): Promise<DisputeAdminListResponse> {
    return this.operations.listDisputes(parseOrThrow(disputeAdminQuerySchema, query));
  }

  @Get('entitlements')
  @RequireAction('operations.view')
  listEntitlements(@Query() query: unknown): Promise<EntitlementAdminListResponse> {
    return this.operations.listEntitlements(parseOrThrow(entitlementAdminQuerySchema, query));
  }

  @Get('entitlements/:id')
  @RequireAction('operations.view')
  findEntitlement(@Param('id') id: string): Promise<EntitlementAdminDetailView> {
    return this.operations.findEntitlement(id);
  }

  /** 発行をやり直す。⚠️ 何度押しても増えない。 */
  @Post('orders/:orderId/retry-issuance')
  @RequireAction('operations.retry')
  retryIssuance(
    @CurrentActor() actor: Actor,
    @Param('orderId') orderId: string,
  ): Promise<RetryIssuanceResponse> {
    return this.operations.retryIssuance(actor, orderId);
  }

  /** その方ぶんをまとめて送り直す。 */
  @Post('accounts/:accountId/redeliver')
  @RequireAction('operations.retry')
  redeliver(
    @CurrentActor() actor: Actor,
    @Param('accountId') accountId: string,
  ): Promise<RedeliverResponse> {
    return this.operations.redeliverForAccount(actor, accountId);
  }
}
