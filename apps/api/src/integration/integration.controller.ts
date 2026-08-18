import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import type { IntegrationListResponse, IntegrationStatusView } from '@sengoku/contracts';
import { registerSecretRequestSchema, updateIntegrationRequestSchema } from '@sengoku/contracts';
import type { Actor } from '@sengoku/auth';
import { isIntegrationService, type IntegrationEnvironment } from '@sengoku/domain';
import { BadRequestException } from '@nestjs/common';
import { CurrentActor, RequireAction } from '../auth/auth.guard';
import { parseOrThrow } from '../common/validation';
import { IntegrationService_ } from './integration.service';

/**
 * 外部連携の設定（管理画面・外部連携 指示書 §12）。
 *
 * ⚠️ **`integration.manage` と `integration.manage_secret` はオーナーの印を
 * 要求する。** 運営の 1 人が乗っ取られただけで送信先ごと差し替えられるのを防ぐ。
 * 判定はガードが済ませており、ここで再判定しない。
 *
 * ⚠️ **登録済みの秘密を返す経路を作らない**（指示書 §6.1・§14）。
 * 取得系はすべて状態と末尾 4 文字までしか返さない。
 *
 * ⚠️ **CSRF は該当しない。** この API は Cookie ではなく
 * `Authorization` ヘッダーで認証する。ブラウザが自動で付ける資格情報が
 * 無いため、他サイトからの誘導では認証が通らない。
 */
@Controller('api/v1/admin/integrations')
export class IntegrationController {
  constructor(private readonly integrations: IntegrationService_) {}

  @Get()
  @RequireAction('integration.view')
  list(): Promise<IntegrationListResponse> {
    return this.integrations.list();
  }

  @Get(':service')
  @RequireAction('integration.view')
  status(@Param('service') service: string): Promise<IntegrationStatusView> {
    return this.integrations.status(parseService(service), this.environment());
  }

  @Patch(':service')
  @RequireAction('integration.manage')
  update(
    @CurrentActor() actor: Actor,
    @Param('service') service: string,
    @Body() body: unknown,
  ): Promise<IntegrationStatusView> {
    return this.integrations.update(
      actor,
      parseService(service),
      this.environment(),
      parseOrThrow(updateIntegrationRequestSchema, body),
    );
  }

  @Post(':service/enable')
  @RequireAction('integration.manage')
  enable(
    @CurrentActor() actor: Actor,
    @Param('service') service: string,
  ): Promise<IntegrationStatusView> {
    return this.integrations.setEnabled(actor, parseService(service), this.environment(), true);
  }

  /**
   * 連携を止める。
   *
   * ⚠️ **止めるほうにも `integration.manage` を要求する。** 誰でも止められると、
   * それ自体が停止させる攻撃になる。運営の合意なく送信が止まる状態は作らない。
   */
  @Post(':service/disable')
  @RequireAction('integration.manage')
  disable(
    @CurrentActor() actor: Actor,
    @Param('service') service: string,
  ): Promise<IntegrationStatusView> {
    return this.integrations.setEnabled(actor, parseService(service), this.environment(), false);
  }

  /**
   * 資格情報を登録する。**待機中として保存し、いきなり有効にしない。**
   *
   * ⚠️ 本文の値をログにも監査ログにも出さない。残るのは末尾 4 文字だけ。
   */
  @Post(':service/secrets')
  @RequireAction('integration.manage_secret')
  registerSecret(
    @CurrentActor() actor: Actor,
    @Param('service') service: string,
    @Body() body: unknown,
  ): Promise<IntegrationStatusView> {
    return this.integrations.registerSecret(
      actor,
      parseService(service),
      this.environment(),
      parseOrThrow(registerSecretRequestSchema, body),
    );
  }

  @Post('secrets/:secretId/activate')
  @RequireAction('integration.manage_secret')
  activateSecret(
    @CurrentActor() actor: Actor,
    @Param('secretId') secretId: string,
  ): Promise<IntegrationStatusView> {
    return this.integrations.activateSecret(actor, secretId);
  }

  @Post('secrets/:secretId/discard')
  @RequireAction('integration.manage_secret')
  discardSecret(
    @CurrentActor() actor: Actor,
    @Param('secretId') secretId: string,
  ): Promise<IntegrationStatusView> {
    return this.integrations.discardSecret(actor, secretId);
  }

  /**
   * このプロセスが扱う環境。
   *
   * ⚠️ **要求から受け取らない。** 経路や本文で環境を指定できると、
   * 本番のプロセスから staging の設定を書き換えられる。逆も同じ。
   * 自分の `APP_ENV` に対応するものだけを触る。
   */
  private environment(): IntegrationEnvironment {
    return this.integrations.appEnvironmentValue;
  }
}

function parseService(value: string) {
  if (!isIntegrationService(value)) {
    // 知らないサービス名は、存在するかどうかも答えない。
    throw new BadRequestException();
  }
  return value;
}
