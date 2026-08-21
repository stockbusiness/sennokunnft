import { Injectable, Logger } from '@nestjs/common';
import {
  audienceFor,
  revisionValues,
  shouldNotifyRevision,
  type ClockPort,
  type LegalDocumentRepository,
  type LegalDocumentVersion,
} from '@sengoku/domain';
import { NotificationService } from '../notification/notification.service';

/**
 * 法務文書の改定を、既存の会員へ知らせる（`UD-127`）。
 *
 * ⚠️ **公開は取り消せない。** 積むのは公開が確定したあとなので、ここで
 * 例外を投げても公開は戻らない。**投げないこと自体が仕様**である——
 * 投げると、公開した人には「失敗した」と見えるのに文書は公開済み、
 * という最も混乱する形になる。
 *
 * ⚠️ **公開の直後と掃き寄せ（cron）の両方から呼ばれる。** 判定を
 * ここへ集めてあるので、二重には積まれない（積む側の UNIQUE も効く）。
 */
@Injectable()
export class LegalRevisionNoticeService {
  private readonly logger = new Logger(LegalRevisionNoticeService.name);

  constructor(
    private readonly legal: LegalDocumentRepository,
    private readonly notifications: NotificationService,
    private readonly clock: ClockPort,
    private readonly siteUrl: string,
  ) {}

  /**
   * その版の知らせを積む。
   *
   * @returns 積んだ件数。⚠️ **0 は「送る相手が居なかった」。** 失敗とは
   *          限らない（立ち上げ直後は誰も同意していない）。
   */
  async enqueueFor(version: LegalDocumentVersion): Promise<number> {
    if (!shouldNotifyRevision(version)) {
      return 0;
    }

    try {
      const audience = audienceFor(version);
      const accountIds = await this.legal.listAccountsConsentedBefore(audience);

      const values = revisionValues({
        // ⚠️ **運営が書いた題を使う。** こちらで label を持つと、
        //    画面の呼び名と届くメールの呼び名がずれる。
        documentName: version.title,
        effectiveFrom: version.effectiveFrom,
        legalUrl: `${this.siteUrl.replace(/\/+$/, '')}/legal/${version.kind}`,
        formatDate: formatJstDate,
      });

      let enqueued = 0;
      let skipped = 0;
      for (const accountId of accountIds) {
        /*
          ⚠️ **1 件ずつ積む。** まとめて 1 トランザクションにすると、
             1 人ぶんの失敗で全員ぶんが巻き戻る。知らせは 1 通ずつ
             独立している。
        */
        const outcome = await this.notifications.enqueue({
          eventType: 'legal.revised',
          subjectId: version.id,
          accountId,
          values,
        });
        if (outcome === 'created') {
          enqueued += 1;
        } else if (outcome === 'skipped') {
          skipped += 1;
        }
      }

      /*
        ⚠️ **積めなかった相手が 1 人でも居たら、印を立てない。** 文面が
           公開されていない・差し込む値が足りない、といった理由で
           `skipped` になったとき印を立ててしまうと、**その改定の知らせは
           永久に届かない**。掃き寄せが拾えるよう、印を立てずに残す。
      */
      if (skipped > 0) {
        this.logger.warn(
          { versionId: version.id, skipped },
          '改定の知らせを積めなかった宛先があるため、印を立てませんでした（掃き寄せが拾い直します）',
        );
        return enqueued;
      }

      /*
        ⚠️ **積み終えてから印を立てる。** 途中で落ちれば印は立たず、
           掃き寄せが拾い直す。積み直しは安全である——同じ
           （種別・版・アカウント）は積む側の UNIQUE が重複として弾く。
      */
      await this.legal.markNoticesEnqueued({ id: version.id, now: this.clock.now() });
      return enqueued;
    } catch (error) {
      /*
        ⚠️ **握りつぶす。** 公開はすでに確定している。ここで投げると、
           公開した人には失敗に見えるのに文書は公開済み、になる。
        ⚠️ **印は立てない。** 立てないので、掃き寄せが拾い直す。
      */
      this.logger.error(
        { versionId: version.id, error: error instanceof Error ? error.name : 'unknown' },
        '改定の知らせを積めませんでした（掃き寄せが拾い直します）',
      );
      return 0;
    }
  }

  /**
   * 取りこぼしを拾う（cron）。
   *
   * ⚠️ **これが最後の砦。** 公開の直後に積むのが本筋だが、そこで落ちると
   * 誰にも届かない。**公開は取り消せない**ので、拾い直す口が要る。
   */
  async sweep(limit = 20): Promise<{ readonly versions: number; readonly enqueued: number }> {
    const pending = await this.legal.listVersionsAwaitingNotices(limit);
    let enqueued = 0;
    for (const version of pending) {
      enqueued += await this.enqueueFor(version);
    }
    return { versions: pending.length, enqueued };
  }
}

/**
 * 施行日の表記。
 *
 * ⚠️ **日本時間で出す。** 保存は UTC だが、「9 月 1 日から」が
 * 8 月 31 日と届くと、読んだ方は 1 日ずれて理解する。
 */
function formatJstDate(value: Date): string {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(value);
}
