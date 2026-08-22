import { Body, Controller, Get, Put } from '@nestjs/common';
import {
  operationsAlertSettingsResponseSchema,
  saveOperationsAlertSettingsRequestSchema,
  type OperationsAlertSettingsResponse,
} from '@sengoku/contracts';
import type { Actor } from '@sengoku/auth';
import type { OperationsAlertSettingsRecord } from '@sengoku/domain';
import { DEFAULT_ALERT_REPEAT_AFTER_MINUTES } from '@sengoku/domain';
import { CurrentActor, RequireAction } from '../auth/auth.guard';
import { parseOrThrow } from '../common/validation';
import { OperationsAlertService } from './alert.service';

/**
 * 運営への知らせの設定（`UD-1102` の一部）。
 *
 * ⚠️ **見るのと変えるのを分けてある。** 「知らせが設定されているか」は
 * 監査の対象そのものなので `operations.view`（`auditor` にも開く）。
 * **変えるのはオーナーだけ**——宛先を差し替えられるということは、
 * 異常に気づく相手を選べるということである。
 *
 * ⚠️ **受け口の URL を読み戻さない。** URL 自体が合言葉である。
 * 返すのはホスト名までにする。
 */
@Controller('api/v1/admin/operations-alerts')
export class AdminOperationsAlertController {
  constructor(private readonly alerts: OperationsAlertService) {}

  @Get()
  @RequireAction('operations.view')
  async show(): Promise<OperationsAlertSettingsResponse> {
    const { record, deliverable, webhookStorable } = await this.alerts.settingsView();
    return parseOrThrow(operationsAlertSettingsResponseSchema, {
      settings: toView(record, deliverable, webhookStorable),
    });
  }

  /**
   * 宛先と条件を保存する。
   *
   * ⚠️ **オーナー限定**（`operations.alert_manage`）。再認証は課していない
   * ——鳴らない状態を早く直せることのほうが大事で、**押した記録は監査ログに
   * 残る**。
   */
  @Put()
  @RequireAction('operations.alert_manage')
  async save(
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
  ): Promise<OperationsAlertSettingsResponse> {
    const parsed = parseOrThrow(saveOperationsAlertSettingsRequestSchema, body);
    const record = await this.alerts.save(parsed, actor);
    const { deliverable, webhookStorable } = await this.alerts.settingsView();
    return parseOrThrow(operationsAlertSettingsResponseSchema, {
      settings: toView(record, deliverable, webhookStorable),
    });
  }
}

/**
 * 画面に出す形へ写す。
 *
 * ⚠️ **`sealedWebhookUrl` をここへ通さない。** 通す口が無いことが、
 * 「読み戻さない」という設計になっている。
 */
function toView(
  record: OperationsAlertSettingsRecord | null,
  deliverable: boolean,
  webhookStorable: boolean,
) {
  if (record === null) {
    /*
      ⚠️ **未設定を「既定で鳴る」にしない。** 宛先を決めていない状態で
         有効にすると、送り先の無い知らせが積まれるだけになる。
    */
    return {
      enabled: false,
      minSeverity: 'critical' as const,
      repeatAfterMinutes: DEFAULT_ALERT_REPEAT_AFTER_MINUTES,
      emailRecipients: [],
      webhookHost: null,
      lastNotifiedAt: null,
      lastSeverity: null,
      deliverable,
      webhookStorable,
    };
  }
  return {
    enabled: record.enabled,
    minSeverity: record.minSeverity,
    repeatAfterMinutes: record.repeatAfterMinutes,
    emailRecipients: [...record.emailRecipients],
    webhookHost: record.webhookHost,
    lastNotifiedAt: record.lastNotifiedAt?.toISOString() ?? null,
    lastSeverity: record.lastSeverity,
    deliverable,
    webhookStorable,
  };
}
