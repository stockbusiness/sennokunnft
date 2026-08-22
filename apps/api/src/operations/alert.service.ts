import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  alertFingerprint,
  buildAlertMessage,
  buildIndicators,
  decideAlert,
  isValidAlertWebhookUrl,
  overallSeverity,
  validateAlertRecipients,
  type AlertDecision,
  type AlertMinSeverity,
  type AlertWebhookPort,
  type ClockPort,
  type OperationsAlertSettingsPort,
  type OperationsAlertSettingsRecord,
  type OperationsMetricsPort,
  type OperationsThresholds,
  type AuditLogPort,
  type SealedSecret,
} from '@sengoku/domain';
import type { Actor } from '@sengoku/auth';
import { DomainErrorException } from '../common/domain-error.filter';
import type { MailTestSender } from '../production/mail-check.service';

/**
 * 運営への知らせ（`UD-1102` の一部・実装 2026-08-22）。
 *
 * ⚠️ **購入者向けの知らせの仕組みへ相乗りしない。** あちらが止まったとき、
 * **止まったことを知らせられなくなる**。異常の知らせは、いちばん壊れて
 * いてほしくない経路なので、独立させる。
 *
 * ⚠️ **送れなくても投げない。** 知らせが送れないことで、知らせようとした
 * 異常の対応が止まってはいけない。
 *
 * ⚠️ **受け口の URL をログへ出さない。** URL 自体が合言葉である。
 */

export const ALERT_CONFIG = Symbol('sengoku:operations-alert-config');

/** 受け口の URL を包む・解く口。⚠️ 暗号鍵が無い配備では `null`。 */
export interface AlertWebhookCipher {
  seal(plaintext: string, environment: string): SealedSecret;
  open(sealed: SealedSecret, environment: string): string | null;
}

export interface AlertConfig {
  readonly settings: OperationsAlertSettingsPort;
  readonly metrics: OperationsMetricsPort;
  readonly thresholds: OperationsThresholds;
  readonly jobKeys: readonly string[];
  readonly clock: ClockPort;
  readonly audit: AuditLogPort;
  /** このプロセスの環境。⚠️ 要求から受け取らない。 */
  readonly appEnvironment: string;
  /** 状況の画面の URL。⚠️ 知らせに載せる唯一のリンク。 */
  readonly dashboardUrl: string;
  /** メールの送り口。⚠️ `null` は「この配備では送れない」。 */
  readonly mailer: MailTestSender | null;
  /** 外部の受け口へ送る口。⚠️ `null` は「この配備では送れない」。 */
  readonly webhook: AlertWebhookPort | null;
  /** 受け口の URL を包む口。⚠️ `null` は「この配備では預かれない」。 */
  readonly cipher: AlertWebhookCipher | null;
}

export interface AlertRunResult {
  readonly decision: AlertDecision;
  readonly emailSent: number;
  readonly emailFailed: number;
  readonly webhookSent: boolean;
}

@Injectable()
export class OperationsAlertService {
  private readonly logger = new Logger(OperationsAlertService.name);

  constructor(@Inject(ALERT_CONFIG) private readonly config: AlertConfig) {}

  async settingsView(): Promise<{
    readonly record: OperationsAlertSettingsRecord | null;
    readonly deliverable: boolean;
    readonly webhookStorable: boolean;
  }> {
    const record = await this.config.settings.find(this.config.appEnvironment);
    return {
      record,
      /*
        ⚠️ **送る口が無い配備がある。** 画面が「設定はできたが届かない」を
           伝えられるように、状態として返す。
      */
      deliverable: this.config.mailer !== null || this.config.webhook !== null,
      webhookStorable: this.config.cipher !== null,
    };
  }

  /**
   * 宛先と条件を保存する。
   *
   * ⚠️ **知らせた記録に触れない。** 触ると、宛先を直しただけで抑制が解け、
   * 直後にもう一度鳴る。
   *
   * ⚠️ **記録に URL も宛先も残さない。** 監査ログに残すのは「変えた」と
   * いう事実と、宛先の数まで。
   */
  async save(
    input: {
      readonly enabled: boolean;
      readonly minSeverity: AlertMinSeverity;
      readonly repeatAfterMinutes: number;
      readonly emailRecipients: readonly string[];
      readonly webhookUrl?: string | undefined;
    },
    actor: Actor,
  ): Promise<OperationsAlertSettingsRecord> {
    const recipients = validateAlertRecipients(input.emailRecipients);
    if (!recipients.ok) {
      throw new DomainErrorException('OPERATIONS_ALERT_SETTINGS_INVALID');
    }

    let sealed: SealedSecret | null | undefined;
    let host: string | null | undefined;
    if (input.webhookUrl !== undefined) {
      const trimmed = input.webhookUrl.trim();
      if (trimmed === '') {
        // ⚠️ 空文字は「外す」。省略（`undefined`）とは別。
        sealed = null;
        host = null;
      } else {
        if (!isValidAlertWebhookUrl(trimmed)) {
          throw new DomainErrorException('OPERATIONS_ALERT_SETTINGS_INVALID');
        }
        if (this.config.cipher === null) {
          /*
            ⚠️ **平文で置く逃げ道を作らない。** 作れば、鍵の設定を忘れた
               配備で静かに合言葉が溜まる。
          */
          throw new DomainErrorException('OPERATIONS_ALERT_WEBHOOK_UNAVAILABLE');
        }
        sealed = this.config.cipher.seal(trimmed, this.config.appEnvironment);
        host = new URL(trimmed).host;
      }
    }

    const now = this.config.clock.now();
    const saved = await this.config.settings.save({
      environment: this.config.appEnvironment,
      enabled: input.enabled,
      minSeverity: input.minSeverity,
      repeatAfterMinutes: input.repeatAfterMinutes,
      emailRecipients: recipients.value,
      ...(sealed === undefined ? {} : { sealedWebhookUrl: sealed, webhookHost: host ?? null }),
      now,
    });

    await this.config.audit.record({
      actorAccountId: actor.accountId,
      action: 'operations.alert_settings_saved',
      targetType: 'environment',
      targetId: this.config.appEnvironment,
      /*
        ⚠️ **宛先も URL もここへ入れない。** 監査ログは長く残り、見る人も
           多い。残すのは「変えた」という事実と数まで。
      */
      summary: {
        enabled: input.enabled,
        minSeverity: input.minSeverity,
        recipientCount: recipients.value.length,
        webhookChanged: sealed !== undefined,
      },
    });
    return saved;
  }

  /**
   * いまの状況を見て、必要なら知らせる。
   *
   * ⚠️ **決してここで投げない。** 時計仕掛けから呼ばれる。投げると、
   * その巡回そのものが失敗として記録され、**知らせの不調が「時計の停止」に
   * 化ける**。
   */
  async run(): Promise<AlertRunResult> {
    const now = this.config.clock.now();
    const settings = await this.config.settings.find(this.config.appEnvironment);
    if (settings === null) {
      return {
        decision: { kind: 'skip', reason: 'disabled' },
        emailSent: 0,
        emailFailed: 0,
        webhookSent: false,
      };
    }

    const [counts, jobs] = await Promise.all([
      this.config.metrics.counts(now),
      this.config.metrics.heartbeats(this.config.jobKeys),
    ]);
    const indicators = buildIndicators({
      counts,
      jobs,
      thresholds: this.config.thresholds,
      now,
    });
    const severity = overallSeverity(indicators);
    const fingerprint = alertFingerprint(indicators);

    const decision = decideAlert({
      settings: {
        enabled: settings.enabled,
        minSeverity: settings.minSeverity,
        repeatAfterMinutes: settings.repeatAfterMinutes,
        emailRecipients: settings.emailRecipients,
        hasWebhook: settings.sealedWebhookUrl !== null,
      },
      severity,
      fingerprint,
      state: {
        lastNotifiedAt: settings.lastNotifiedAt,
        lastSeverity: settings.lastSeverity,
        lastFingerprint: settings.lastFingerprint,
      },
      now,
    });

    if (decision.kind === 'skip') {
      return { decision, emailSent: 0, emailFailed: 0, webhookSent: false };
    }

    const message = buildAlertMessage({
      severity,
      reason: decision.reason,
      indicators,
      dashboardUrl: this.config.dashboardUrl,
    });

    let emailSent = 0;
    let emailFailed = 0;
    if (this.config.mailer !== null) {
      for (const to of settings.emailRecipients) {
        try {
          const outcome = await this.config.mailer.send({
            to,
            subject: message.subject,
            body: message.body,
            /*
              ⚠️ **指紋と時刻から鍵を作る。** 同じ知らせが二重に飛ぶのを
                 送信側でも止める。宛先は鍵に入れない（宛先ごとに 1 通
                 送るのが正しい）。
            */
            idempotencyKey: `alert:${this.config.appEnvironment}:${String(now.getTime())}:${to}`,
          });
          if (outcome.kind === 'accepted') {
            emailSent += 1;
          } else {
            emailFailed += 1;
          }
        } catch {
          // ⚠️ 1 通の失敗で、ほかの宛先まで止めない。
          emailFailed += 1;
        }
      }
    }

    let webhookSent = false;
    if (
      this.config.webhook !== null &&
      this.config.cipher !== null &&
      settings.sealedWebhookUrl !== null
    ) {
      const url = this.config.cipher.open(settings.sealedWebhookUrl, this.config.appEnvironment);
      if (url === null) {
        /*
          ⚠️ **解けないことを黙って見逃さない。** 鍵の入れ替えを誤ったか、
             行が差し替えられたか。**どちらでも知らせは届いていない。**
             ⚠️ URL もホスト名も載せない。
        */
        this.logger.warn('知らせの受け口を解けませんでした。設定を確かめてください。');
      } else {
        const outcome = await this.config.webhook.post(url, message);
        webhookSent = outcome.ok;
      }
    }

    /*
      ⚠️ **1 つも届いていなければ、知らせた印を立てない。** 立てると、
         次の巡回が「もう知らせた」として黙る。**届いていないのに黙るのが、
         この仕組みでいちばん困る壊れ方**である。
    */
    if (emailSent === 0 && !webhookSent) {
      this.logger.warn(`知らせを送れませんでした（宛先 ${String(emailFailed)} 件が失敗）。`);
      return { decision, emailSent, emailFailed, webhookSent };
    }

    await this.config.settings.markNotified({
      environment: this.config.appEnvironment,
      severity,
      fingerprint,
      now,
    });
    return { decision, emailSent, emailFailed, webhookSent };
  }
}
