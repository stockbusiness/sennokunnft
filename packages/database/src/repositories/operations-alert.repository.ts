import type { PrismaClient } from '../../generated/client';
import type {
  AlertMinSeverity,
  OperationsAlertSettingsPort,
  OperationsAlertSettingsRecord,
  OperationsSeverity,
  SealedSecret,
} from '@sengoku/domain';

/**
 * 運営への知らせの設定（`UD-1102` の一部）。
 *
 * ⚠️ **保存で「知らせた記録」に触れない。** 触ると、宛先を直しただけで
 * 抑制が解け、直後にもう一度鳴る。列を分けてあるのは、そのためである。
 *
 * ⚠️ **外部の受け口の URL は包んだまま持つ。** 平文の列は無い。
 */
export class PrismaOperationsAlertSettingsRepository implements OperationsAlertSettingsPort {
  constructor(private readonly prisma: PrismaClient) {}

  async find(environment: string): Promise<OperationsAlertSettingsRecord | null> {
    const row = await this.prisma.operationsAlertSettings.findUnique({ where: { environment } });
    return row === null ? null : toRecord(row);
  }

  async save(input: {
    readonly environment: string;
    readonly enabled: boolean;
    readonly minSeverity: AlertMinSeverity;
    readonly repeatAfterMinutes: number;
    readonly emailRecipients: readonly string[];
    readonly sealedWebhookUrl?: SealedSecret | null | undefined;
    readonly webhookHost?: string | null | undefined;
    readonly now: Date;
  }): Promise<OperationsAlertSettingsRecord> {
    /*
      ⚠️ **`undefined` は「変えない」、`null` は「外す」。** 分けずに扱うと、
         宛先だけを直したつもりが受け口ごと消える。
    */
    const webhook =
      input.sealedWebhookUrl === undefined
        ? {}
        : input.sealedWebhookUrl === null
          ? {
              webhookCiphertext: null,
              webhookNonce: null,
              webhookAuthTag: null,
              webhookKeyVersion: null,
              webhookHost: null,
            }
          : {
              webhookCiphertext: input.sealedWebhookUrl.ciphertext,
              webhookNonce: input.sealedWebhookUrl.nonce,
              webhookAuthTag: input.sealedWebhookUrl.authTag,
              webhookKeyVersion: input.sealedWebhookUrl.keyVersion,
              webhookHost: input.webhookHost ?? null,
            };

    const shared = {
      enabled: input.enabled,
      minSeverity: input.minSeverity,
      repeatAfterMinutes: input.repeatAfterMinutes,
      emailRecipients: [...input.emailRecipients],
      ...webhook,
      updatedAt: input.now,
    };

    const row = await this.prisma.operationsAlertSettings.upsert({
      where: { environment: input.environment },
      create: { environment: input.environment, ...shared },
      // ⚠️ `lastNotifiedAt` ほかは書かない。抑制の記録に触れない。
      update: shared,
    });
    return toRecord(row);
  }

  async markNotified(input: {
    readonly environment: string;
    readonly severity: OperationsSeverity;
    readonly fingerprint: string;
    readonly now: Date;
  }): Promise<void> {
    await this.prisma.operationsAlertSettings.update({
      where: { environment: input.environment },
      /*
        ⚠️ **宛先や条件を書かない。** 送信のたびに設定を書き戻すと、
           同時に人が直した内容を巻き戻す。
      */
      data: {
        lastNotifiedAt: input.now,
        lastSeverity: input.severity,
        lastFingerprint: input.fingerprint,
      },
    });
  }
}

function toRecord(row: {
  environment: string;
  enabled: boolean;
  minSeverity: string;
  repeatAfterMinutes: number;
  emailRecipients: string[];
  webhookCiphertext: string | null;
  webhookNonce: string | null;
  webhookAuthTag: string | null;
  webhookKeyVersion: string | null;
  webhookHost: string | null;
  lastNotifiedAt: Date | null;
  lastSeverity: string | null;
  lastFingerprint: string | null;
  updatedAt: Date;
}): OperationsAlertSettingsRecord {
  /*
    ⚠️ **包みは 4 つそろっているときだけ組み立てる。** DB の CHECK が
       片方だけの行を止めているが、読む側でも確かめる（制約を外した配備で
       静かに壊れないように）。
  */
  const sealed =
    row.webhookCiphertext !== null &&
    row.webhookNonce !== null &&
    row.webhookAuthTag !== null &&
    row.webhookKeyVersion !== null
      ? {
          ciphertext: row.webhookCiphertext,
          nonce: row.webhookNonce,
          authTag: row.webhookAuthTag,
          keyVersion: row.webhookKeyVersion,
          // ⚠️ 受け口の URL に「末尾 4 桁」の意味は無い。空で持つ。
          lastFour: '',
        }
      : null;

  return {
    environment: row.environment,
    enabled: row.enabled,
    minSeverity: row.minSeverity === 'warning' ? 'warning' : 'critical',
    repeatAfterMinutes: row.repeatAfterMinutes,
    emailRecipients: row.emailRecipients,
    sealedWebhookUrl: sealed,
    webhookHost: row.webhookHost,
    lastNotifiedAt: row.lastNotifiedAt,
    lastSeverity: toSeverity(row.lastSeverity),
    lastFingerprint: row.lastFingerprint,
    updatedAt: row.updatedAt,
  };
}

function toSeverity(value: string | null): OperationsSeverity | null {
  if (value === 'critical' || value === 'warning' || value === 'normal') {
    return value;
  }
  return null;
}
