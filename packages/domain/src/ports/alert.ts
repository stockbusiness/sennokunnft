import type { AlertMessage } from '../operations/alert';
import type { AlertMinSeverity } from '../operations/alert';
import type { OperationsSeverity } from '../operations/dashboard';
import type { SealedSecret } from './integration';

/**
 * 運営への知らせの設定（`UD-1102` の一部）。
 *
 * ⚠️ **環境ごとに 1 件。** staging と production で宛先が違う。1 件に
 * まとめると、試したつもりの知らせが本番の担当者へ飛ぶ。
 *
 * ⚠️ **外部の受け口の URL は包んで持つ。** URL 自体が合言葉である
 * （Slack の受け口などがそう）。読み戻しでは返さない。
 */
export interface OperationsAlertSettingsRecord {
  readonly environment: string;
  readonly enabled: boolean;
  readonly minSeverity: AlertMinSeverity;
  readonly repeatAfterMinutes: number;
  readonly emailRecipients: readonly string[];
  /** ⚠️ **包んだまま持つ。** 平文の列は無い。 */
  readonly sealedWebhookUrl: SealedSecret | null;
  /** 画面に出す伏せた表記。⚠️ ここから元へは戻せない。 */
  readonly webhookHost: string | null;
  readonly lastNotifiedAt: Date | null;
  readonly lastSeverity: OperationsSeverity | null;
  readonly lastFingerprint: string | null;
  readonly updatedAt: Date;
}

export interface OperationsAlertSettingsPort {
  find(environment: string): Promise<OperationsAlertSettingsRecord | null>;
  /**
   * 宛先と条件を保存する。
   *
   * ⚠️ **知らせた記録（`lastNotifiedAt` ほか）に触れない。** ここで
   * 触ると、宛先を直しただけで抑制が解け、直後にもう一度鳴る。
   */
  save(input: {
    readonly environment: string;
    readonly enabled: boolean;
    readonly minSeverity: AlertMinSeverity;
    readonly repeatAfterMinutes: number;
    readonly emailRecipients: readonly string[];
    /** `undefined` は「変えない」、`null` は「外す」。⚠️ 分けて扱う。 */
    readonly sealedWebhookUrl?: SealedSecret | null | undefined;
    readonly webhookHost?: string | null | undefined;
    readonly now: Date;
  }): Promise<OperationsAlertSettingsRecord>;
  /** 知らせたことを記録する。⚠️ 宛先や条件には触れない。 */
  markNotified(input: {
    readonly environment: string;
    readonly severity: OperationsSeverity;
    readonly fingerprint: string;
    readonly now: Date;
  }): Promise<void>;
}

/**
 * 外部の受け口へ知らせを送る（Slack の受け口など）。
 *
 * ⚠️ **失敗しても投げない。** 知らせが送れないことで、知らせようとした
 * 異常の対応が止まってはいけない。
 */
export interface AlertWebhookPort {
  post(url: string, message: AlertMessage): Promise<{ readonly ok: boolean }>;
}
