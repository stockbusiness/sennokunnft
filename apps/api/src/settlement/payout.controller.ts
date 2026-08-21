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
  adminPayoutAccountResponseSchema,
  closePayoutPeriodRequestSchema,
  closePayoutPeriodResponseSchema,
  payoutDetailResponseSchema,
  payoutListQuerySchema,
  payoutListResponseSchema,
  payoutSchema,
  type AdminPayoutAccountResponse,
  type ClosePayoutPeriodResponse,
  type PayoutDetailResponse,
  type PayoutListResponse,
  type PayoutViewDto,
} from '@sengoku/contracts';
import type { Actor } from '@sengoku/auth';
import type { PayoutLineView, PayoutView } from '@sengoku/domain';
import { CurrentActor, RequireAction, RequireFreshAuth } from '../auth/auth.guard';
import { parseOrThrow } from '../common/validation';
import { PayoutService } from './payout.service';

/**
 * 作家さまへの精算（`UD-119`。決定 2026-08-20）。
 *
 * ⚠️ **金額を受け取る口を置かない**（`SETTLEMENT_AND_REFUND.md` §4）。
 * 合計も明細も、集計が決めた値だけ。訂正は**次の期間での調整**として行う。
 * 直接書き換えを許すと、明細と振込額が食い違ったときに、どちらが正しいのか
 * 誰にも分からなくなる。
 *
 * ⚠️ **精算を消す口も置かない。** 作り直しは下書きのときだけ、`close` が
 * 置き換える形で行う。
 */
@Controller('api/v1/admin/payouts')
export class AdminPayoutController {
  constructor(private readonly payouts: PayoutService) {}

  /**
   * 一覧。
   *
   * ⚠️ **`auditor` にも開く。** いくら誰へ払ったかが見えないと監査に
   * ならない。締めること（`payout.manage`）とは別の力として分けてある。
   */
  @Get()
  @RequireAction('payout.view')
  async list(@Query() rawQuery: Record<string, unknown>): Promise<PayoutListResponse> {
    const query = parseOrThrow(payoutListQuerySchema, rawQuery);
    const items = await this.payouts.list(query);
    return parseOrThrow(payoutListResponseSchema, { items: items.map(toDto) });
  }

  @Get(':id')
  @RequireAction('payout.view')
  async detail(@Param('id') id: string): Promise<PayoutDetailResponse> {
    const found = await this.payouts.detail(id);
    if (found === null) {
      throw new NotFoundException();
    }
    return parseOrThrow(payoutDetailResponseSchema, {
      payout: toDto(found.payout),
      lines: found.lines.map(toLineDto),
      openRefundWindows: found.openRefundWindows,
      // ⚠️ **状態だけ。** 銀行名も名義も番号も、ここには載せない。
      payoutAccountStatus: found.payoutAccountStatus,
    });
  }

  /**
   * 振込のために、お振込先を伏せずに読む（決定 2026-08-21）。
   *
   * ⚠️ **明細（`detail`）に混ぜていない。** 混ぜると、精算を開いた
   * だけで口座番号が経路へ流れ、監査ログが「開いた人」で埋まって
   * **本当に読んだ人が埋もれる**。読むと決めたときだけ、この口を叩く。
   *
   * ⚠️ **`payout.view` では通らない。** いくら払うかを見ることと、
   * どこへ振り込むかを読むことは別の力である（`auditor` には渡していない）。
   *
   * ⚠️ **精算を指してもらう。** 作家さまを直に指定する口にしない——
   * 「作家さま一覧から口座を順に開く」ができてしまう。
   */
  @Get(':id/payout-account')
  @RequireAction('payout_account.view_full')
  async payoutAccount(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
  ): Promise<AdminPayoutAccountResponse> {
    const result = await this.payouts.revealPayoutAccount({
      payoutId: id,
      actorAccountId: requireAccountId(actor),
    });
    if (result === null) {
      throw new NotFoundException();
    }
    return parseOrThrow(
      adminPayoutAccountResponseSchema,
      result.status === 'resolved'
        ? {
            status: 'resolved',
            account: { ...result.account, updatedAt: result.account.updatedAt.toISOString() },
          }
        : { status: result.status },
    );
  }

  /**
   * 期間を締めて、作家さまごとの下書きを作る。
   *
   * ⚠️ **作家さまを指定させない。** その期間に売上か繰越のある方を、
   * こちらで洗い出す。指定できると、指定し忘れた方がいつまでも
   * 支払われない——そして誰も気づかない。
   *
   * ⚠️ **何度でも押してよい。** 下書きは作り直せる。締めたあとの精算は
   * 飛ばすので、押し直しても確定済みの金額は動かない。
   */
  @Post('close')
  @RequireAction('payout.manage')
  @HttpCode(HttpStatus.CREATED)
  async close(
    @CurrentActor() actor: Actor,
    @Body() rawBody: unknown,
  ): Promise<ClosePayoutPeriodResponse> {
    const body = parseOrThrow(closePayoutPeriodRequestSchema, rawBody);
    const result = await this.payouts.closePeriod({
      periodKey: body.periodKey,
      actorAccountId: requireAccountId(actor),
    });
    return parseOrThrow(closePayoutPeriodResponseSchema, {
      periodKey: result.periodKey,
      items: result.items.map(toDto),
    });
  }

  /**
   * 確定する。
   *
   * ⚠️ **返金の窓が開いている注文が 1 件でもあれば断る**
   * （`SETTLEMENT_AND_REFUND.md` §2-3）。
   */
  @Post(':id/confirm')
  @RequireAction('payout.manage')
  @HttpCode(HttpStatus.OK)
  async confirm(@CurrentActor() actor: Actor, @Param('id') id: string): Promise<PayoutViewDto> {
    const payout = await this.payouts.confirm({
      payoutId: id,
      actorAccountId: requireAccountId(actor),
    });
    return parseOrThrow(payoutSchema, toDto(payout));
  }

  /**
   * 支払い済みにする。
   *
   * ⚠️ **これは「振り込んだ」という宣言であって、振込そのものではない。**
   * 実際に振り込んだかを機械は確かめられないので、**オーナー限定＋再認証**
   * にしてある。記録だけ進めれば、作家さまには「支払い済み」と見えたまま
   * 入金が無い、という状態を作れてしまう。
   */
  @Post(':id/mark-paid')
  @RequireAction('payout.mark_paid')
  @RequireFreshAuth()
  @HttpCode(HttpStatus.OK)
  async markPaid(@CurrentActor() actor: Actor, @Param('id') id: string): Promise<PayoutViewDto> {
    const payout = await this.payouts.markPaid({
      payoutId: id,
      actorAccountId: requireAccountId(actor),
    });
    return parseOrThrow(payoutSchema, toDto(payout));
  }
}

function toDto(payout: PayoutView): PayoutViewDto {
  return {
    ...payout,
    periodStart: payout.periodStart.toISOString(),
    periodEnd: payout.periodEnd.toISOString(),
    dueAt: payout.dueAt.toISOString(),
    confirmedAt: payout.confirmedAt?.toISOString() ?? null,
    paidAt: payout.paidAt?.toISOString() ?? null,
    createdAt: payout.createdAt.toISOString(),
  };
}

function toLineDto(line: PayoutLineView): PayoutLineView {
  return line;
}

function requireAccountId(actor: Actor): string {
  if (actor.accountId === null || actor.accountId === undefined) {
    // ガードが通しているので通常は来ない。来たら開かない側へ倒す。
    throw new ForbiddenException();
  }
  return actor.accountId;
}
