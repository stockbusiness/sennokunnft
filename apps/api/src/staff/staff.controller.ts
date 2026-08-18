import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import type {
  AcceptInvitationResponse,
  StaffInvitationView,
  StaffListResponse,
  StaffMemberView,
} from '@sengoku/contracts';
import {
  createStaffInvitationRequestSchema,
  updateStaffMemberRequestSchema,
} from '@sengoku/contracts';
import type { Actor } from '@sengoku/auth';
import { CurrentActor, CurrentVerifiedEmail, RequireAction } from '../auth/auth.guard';
import { parseOrThrow } from '../common/validation';
import { StaffService } from './staff.service';

/**
 * 運営スタッフの招待と権限（`UD-803` 決定 2026-08-18）。
 *
 * ⚠️ **`staff.*` はオーナーの印を要求する。** ロールが `operator` でも、
 * 印が無ければガードが止める（`packages/auth` の `OWNER_ONLY_ACTIONS`）。
 * ここが緩むと、運営の 1 人が乗っ取られただけで全権限を配り直される。
 */
@Controller('api/v1/admin/staff')
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @Get()
  @RequireAction('staff.view')
  list(@CurrentActor() actor: Actor): Promise<StaffListResponse> {
    return this.staff.list(actor);
  }

  @Post('invitations')
  @RequireAction('staff.invite')
  invite(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<StaffInvitationView> {
    return this.staff.invite(actor, parseOrThrow(createStaffInvitationRequestSchema, body));
  }

  @Delete('invitations/:id')
  @RequireAction('staff.invite')
  revoke(@CurrentActor() actor: Actor, @Param('id') id: string): Promise<StaffInvitationView> {
    return this.staff.revoke(actor, id);
  }

  @Patch(':accountId')
  @RequireAction('staff.manage')
  update(
    @CurrentActor() actor: Actor,
    @Param('accountId') accountId: string,
    @Body() body: unknown,
  ): Promise<StaffMemberView> {
    return this.staff.updateMember(
      actor,
      accountId,
      parseOrThrow(updateStaffMemberRequestSchema, body),
    );
  }
}

/**
 * ログインした本人が、自分宛の招待を引き取る入口。
 *
 * ⚠️ **管理APIの下に置かない。** あちらはオーナーだけが通れる区画で、
 * ここを通るのは、まだ何の権限も無い招待された人だから。
 *
 * ⚠️ **招待IDを受け取らない。** 受け取る形にすると、他人宛の招待IDを
 * 指定して権限を取れる。引けるのは**自分の確認済みアドレス**からだけ。
 */
@Controller('api/v1/me')
export class StaffInvitationAcceptController {
  constructor(private readonly staff: StaffService) {}

  @Post('staff-invitation/accept')
  // 会員なら誰でも呼べてよい。自分宛の招待しか引けないため。
  @RequireAction('collection.view')
  accept(
    @CurrentActor() actor: Actor,
    @CurrentVerifiedEmail() verifiedEmail: string | undefined,
  ): Promise<AcceptInvitationResponse> {
    return this.staff.acceptForSelf(actor, verifiedEmail);
  }
}
