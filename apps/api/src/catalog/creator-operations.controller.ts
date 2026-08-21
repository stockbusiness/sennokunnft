import { Body, Controller, ForbiddenException, Get, Header, Put, Query } from '@nestjs/common';
import type {
  CreatorEarningsDetailResponse,
  CreatorEarningsResponse,
  CreatorProfileDetailView,
} from '@sengoku/contracts';
import {
  creatorEarningsQuerySchema,
  updateCreatorProfileDetailRequestSchema,
} from '@sengoku/contracts';
import type { Actor } from '@sengoku/auth';
import { CurrentActor, RequireAction } from '../auth/auth.guard';
import { parseOrThrow } from '../common/validation';
import { CreatorOperationsService } from './creator-operations.service';

/**
 * 作家さまの売上とプロフィール（実運営 指示書 P1-2）。
 *
 * ⚠️ **自分の分しか見られない。** 誰の分かを、本文でも URL でも
 * 問い合わせでも受け取らない。アカウントは**トークンから**取る。
 * 受け取れる形にすると、そこが他人の売上を覗く道になる——売上は、
 * その方の商いの中身そのものである。
 *
 * ⚠️ **運営向けの「作家さまの売上を見る」口をここへ足さない。** 必要なら
 * `/api/v1/admin/payouts`（`payout.view`）を使う。同じ経路に混ぜると、
 * 「自分の分だけ」という縛りが緩む。
 *
 * ⚠️ **売上とプロフィールで門が違う。** 名乗る名前は誰でも決められるが
 * （`profile.manage_own`）、売上は商いの中身なので `creator.earnings.view_own`
 * で別に切ってある。閲覧者（`auditor`）は名乗りも売上も持たない。
 */
@Controller('api/v1/creator')
export class CreatorOperationsController {
  constructor(private readonly creator: CreatorOperationsService) {}

  /** 売上のまとめ。⚠️ 進行中の期間は見込み、過ぎた期間は締めた記録。 */
  @Get('earnings')
  @RequireAction('creator.earnings.view_own')
  earnings(@CurrentActor() actor: Actor): Promise<CreatorEarningsResponse> {
    return this.creator.earningsOf(requireAccountId(actor));
  }

  /** ある期間の明細。⚠️ 省略なら進行中の期間。 */
  @Get('earnings/detail')
  @RequireAction('creator.earnings.view_own')
  detail(
    @CurrentActor() actor: Actor,
    @Query() query: unknown,
  ): Promise<CreatorEarningsDetailResponse> {
    const parsed = parseOrThrow(creatorEarningsQuerySchema, query);
    return this.creator.detailOf(requireAccountId(actor), parsed.periodKey);
  }

  /**
   * 明細を CSV で受け取る。
   *
   * ⚠️ **BOM を付ける。** 付けないと、Excel が UTF-8 と判断せず、
   * 作品名が文字化けする。**開いた作家さまには、こちらの不具合に見える。**
   */
  @Get('earnings/csv')
  @RequireAction('creator.earnings.view_own')
  @Header('content-type', 'text/csv; charset=utf-8')
  @Header('content-disposition', 'attachment; filename="earnings.csv"')
  async csv(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<string> {
    const parsed = parseOrThrow(creatorEarningsQuerySchema, query);
    const csv = await this.creator.csvOf(requireAccountId(actor), parsed.periodKey);
    // ⚠️ 文字そのものではなく符号で書く。見えない文字はレビューで消える。
    return `\uFEFF${csv}`;
  }

  @Get('profile/detail')
  @RequireAction('profile.manage_own')
  profile(@CurrentActor() actor: Actor): Promise<CreatorProfileDetailView> {
    return this.creator.profileOf(requireAccountId(actor));
  }

  /** プロフィールを保存する。⚠️ 表示名と画像には触れない（別の口）。 */
  @Put('profile/detail')
  @RequireAction('profile.manage_own')
  saveProfile(
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
  ): Promise<CreatorProfileDetailView> {
    const parsed = parseOrThrow(updateCreatorProfileDetailRequestSchema, body);
    return this.creator.saveProfile(requireAccountId(actor), parsed);
  }

  /*
    ⚠️ **ここに置かないもの:**
      - 誰の分かを指定して売上を見る口（他人の商いの中身が見える）
      - 作品審査の申請・承認（`UD-102` と衝突。決定待ち）
      - お振込先の登録（P1-3）
  */
}

/** ⚠️ ガードが通しているので通常は来ない。来たら開かない側へ倒す。 */
function requireAccountId(actor: Actor): string {
  if (actor.accountId === null || actor.accountId === undefined) {
    throw new ForbiddenException();
  }
  return actor.accountId;
}
