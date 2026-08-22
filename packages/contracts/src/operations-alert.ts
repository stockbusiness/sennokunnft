import { z } from 'zod';

/**
 * 運営への知らせの設定（`UD-1102` の一部）。
 *
 * ⚠️ **受け口の URL を読み戻さない。** URL 自体が合言葉である（Slack の
 * 受け口などがそう）。返すのはホスト名までにする。
 *
 * ⚠️ **宛先は運営の業務用アドレスだけ。** お客さまのアドレスを入れる欄では
 * ない（`UD-503`）。画面でもそう伝える。
 */

export const ALERT_MIN_SEVERITY_VALUES = ['warning', 'critical'] as const;

export const operationsAlertSettingsSchema = z.object({
  enabled: z.boolean(),
  minSeverity: z.enum(ALERT_MIN_SEVERITY_VALUES),
  repeatAfterMinutes: z.number().int(),
  emailRecipients: z.array(z.string()),
  /** ⚠️ **ホスト名まで。** 経路（合言葉）は返さない。 */
  webhookHost: z.string().nullable(),
  /** 最後に知らせた時刻。⚠️ `null` は「一度も知らせていない」。 */
  lastNotifiedAt: z.string().nullable(),
  lastSeverity: z.enum(['normal', 'warning', 'critical']).nullable(),
  /** この配備で知らせを送れるか。⚠️ 送る口が無ければ `false`。 */
  deliverable: z.boolean(),
  /** 暗号鍵が無い配備では受け口を預かれない。 */
  webhookStorable: z.boolean(),
});
export type OperationsAlertSettingsView = z.infer<typeof operationsAlertSettingsSchema>;

export const operationsAlertSettingsResponseSchema = z.object({
  settings: operationsAlertSettingsSchema,
});
export type OperationsAlertSettingsResponse = z.infer<typeof operationsAlertSettingsResponseSchema>;

export const saveOperationsAlertSettingsRequestSchema = z.object({
  enabled: z.boolean(),
  minSeverity: z.enum(ALERT_MIN_SEVERITY_VALUES),
  repeatAfterMinutes: z.number().int().min(15).max(1440),
  emailRecipients: z.array(z.string().trim()).max(5),
  /**
   * 受け口の URL。
   *
   * ⚠️ **省略は「変えない」、空文字は「外す」。** 分けずに扱うと、宛先だけを
   * 直したつもりが受け口ごと消える。
   */
  webhookUrl: z.string().optional(),
});
export type SaveOperationsAlertSettingsRequest = z.infer<
  typeof saveOperationsAlertSettingsRequestSchema
>;

/**
 * 知らせを判定して送った結果（時計仕掛けが叩く口の応答）。
 *
 * ⚠️ **宛先も URL も返さない。** これは監視の数値として読まれる応答で、
 * ログや監視ツールへ流れていく。人の情報も合言葉も混ぜない。
 */
export const notifyOperationsAlertsResponseSchema = z.object({
  /** notify / skip。⚠️ どちらも異常ではない。 */
  outcome: z.enum(['notified', 'skipped']),
  /** なぜそうしたか。⚠️ **沈黙に理由を付ける**（壊れているのと見分ける）。 */
  reason: z.string(),
  emailSent: z.number().int(),
  emailFailed: z.number().int(),
  webhookSent: z.boolean(),
});
export type NotifyOperationsAlertsResponse = z.infer<typeof notifyOperationsAlertsResponseSchema>;
