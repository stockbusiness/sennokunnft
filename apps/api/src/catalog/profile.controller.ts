import { Body, Controller, ForbiddenException, Get, Inject, Put } from '@nestjs/common';
import {
  creatorProfileSchema,
  updateCreatorProfileRequestSchema,
  type CreatorProfileView,
} from '@sengoku/contracts';
import type { Actor } from '@sengoku/auth';
import {
  validateDisplayName,
  type AuditLogPort,
  type CreatorProfileRepository,
} from '@sengoku/domain';
import { CurrentActor, RequireAction } from '../auth/auth.guard';
import { DomainErrorException } from '../common/domain-error.filter';
import { parseOrThrow } from '../common/validation';

/** 注入の合図。⚠️ interface は実行時に消えるので、型では注入できない。 */
export const PROFILE_CONFIG = Symbol('sengoku:profile-config');

export interface ProfileConfig {
  readonly repository: CreatorProfileRepository;
  readonly audit: AuditLogPort;
}

/**
 * 自分のプロフィール（決定 2026-08-20）。
 *
 * **屋号・ペンネームを許す。重複は許さない。**
 *
 * ⚠️ **自分の分しか触れない。** 誰の分かを本文でも URL でも受け取らない。
 * アカウントは**トークンから**取る。受け取れる形にすると、そこが他人の
 * 名前を書き換える道になる——名乗る名前は本人のもので、運営が勝手に
 * 変えるものではない。
 *
 * ⚠️ **なりすましへの対応は、名前の書き換えではなくアカウントの停止で行う。**
 * だから運営向けの「表示名を直す」口をここへ足さないこと。
 */
@Controller('api/v1/creator/profile')
export class CreatorProfileController {
  constructor(@Inject(PROFILE_CONFIG) private readonly config: ProfileConfig) {}

  @Get()
  @RequireAction('profile.manage_own')
  async read(@CurrentActor() actor: Actor): Promise<CreatorProfileView> {
    const accountId = requireAccountId(actor);
    const profile = await this.config.repository.find(accountId);
    // ⚠️ 未登録なら `null`。代わりの文言をここで作らない。
    return parseOrThrow(creatorProfileSchema, { displayName: profile?.displayName ?? null });
  }

  /**
   * 表示名を決める・変える。
   *
   * ⚠️ **「使われているか」を先に問い合わせない。** 問い合わせてから書くと、
   * 同時に登録した 2 人が両方通る。書いてみて、断られたら伝える。
   */
  @Put()
  @RequireAction('profile.manage_own')
  async update(
    @CurrentActor() actor: Actor,
    @Body() rawBody: unknown,
  ): Promise<CreatorProfileView> {
    const body = parseOrThrow(updateCreatorProfileRequestSchema, rawBody);
    const accountId = requireAccountId(actor);

    /*
      ⚠️ **見た目の重複をここで潰す。** 全角と半角、大文字と小文字、空白の
         有無——買う人にはどれも区別が付かない。正規化した鍵を作り、
         それに DB の UNIQUE を張ってある。
    */
    const validated = validateDisplayName(body.displayName);
    if (!validated.ok) {
      throw new DomainErrorException(validated.error.code);
    }

    const saved = await this.config.repository.saveDisplayName(accountId, validated.value);
    if (!saved.ok) {
      throw new DomainErrorException(saved.error.code);
    }

    await this.config.audit.record({
      actorAccountId: accountId,
      action: 'profile.display_name_updated',
      targetType: 'account',
      targetId: accountId,
      /*
        ⚠️ **名前そのものを残す。** 公開ページに出る値で、秘密ではない。
           あとから「いつ改名したか」を追えないと、なりすましの相談を
           受けたときに調べようがない。
      */
      summary: { displayName: saved.value.displayName },
    });

    return parseOrThrow(creatorProfileSchema, { displayName: saved.value.displayName });
  }
}

function requireAccountId(actor: Actor): string {
  if (actor.accountId === null || actor.accountId === undefined) {
    // ガードが通しているので通常は来ない。来たら開かない側へ倒す。
    throw new ForbiddenException();
  }
  return actor.accountId;
}
