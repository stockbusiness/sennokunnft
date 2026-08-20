import { Injectable } from '@nestjs/common';
import {
  decideNotification,
  maskEmail,
  NOTIFICATION_MAX_ATTEMPTS,
  type AuditLogPort,
  type ClockPort,
  type EmailHashPort,
  type MailSenderPort,
  type NotificationOutboxPort,
  type NotificationRecord,
  type RecipientResolverPort,
} from '@sengoku/domain';
import type { Logger } from '@sengoku/observability';

/** 1 巡の結果。⚠️ 何が起きたかを丸めずに返す。 */
export interface NotificationSendResult {
  readonly picked: number;
  readonly sent: number;
  readonly skipped: number;
  readonly failed: number;
}

/**
 * `PROCESSING` のまま取り残された行を戻すまでの猶予。
 *
 * ⚠️ **短くしすぎない。** 送信中の行を戻すと、同じ知らせが 2 通届く。
 * 送信の上限（既定 10 秒）より十分長く取る。
 */
const STALE_AFTER_MS = 10 * 60_000;

/**
 * 積まれた知らせを実際に送る（P0-4）。
 *
 * ⚠️ **宛先はここで初めて取り出す。** DB には伏せた表記しか無い（`UD-503`）。
 * 送り終えたら捨てる。**変数へ残さない、ログへ出さない、例外へ載せない。**
 *
 * ⚠️ **1 通の失敗で巡回を止めない。** 1 件のおかしな宛先で、後ろに並んだ
 * 全員の知らせが止まる。1 通ずつ独立して扱う。
 */
@Injectable()
export class NotificationSendService {
  constructor(
    private readonly outbox: NotificationOutboxPort,
    private readonly recipients: RecipientResolverPort,
    private readonly mailer: MailSenderPort,
    private readonly emailHash: EmailHashPort,
    private readonly clock: ClockPort,
    private readonly audit: AuditLogPort,
    private readonly logger: Logger,
    /**
     * 「届いた」「止まっている」を積む処理（P0-4）。
     *
     * ⚠️ **`null` でも送信は動く。** 積む側と送る側を独立させておくと、
     * 片方の不具合でもう片方が止まらない。
     */
    private readonly sweepSource: { sweep(limit: number): Promise<unknown> } | null = null,
  ) {}

  async sweep(limit: number): Promise<NotificationSendResult> {
    const now = this.clock.now();

    /*
      ⚠️ **送る前に、届いた／止まっているぶんを積む。** どちらも配送ワーカー
         の側で起きるので、こちらの状態から導く。積んだそばから同じ巡回で
         送れるため、時計を 2 本に分けずに済む。
      ⚠️ **積めなくても送信は続ける。** ここで落とすと、既に積んである分まで
         止まる。
    */
    if (this.sweepSource !== null) {
      try {
        await this.sweepSource.sweep(limit);
      } catch {
        // ⚠️ 中身を見ない・出さない。次の巡回で拾い直す。
        this.logger.warn({}, 'お届け結果の知らせを積めませんでした');
      }
    }

    /*
      ⚠️ **掃き出しの前に、取り残された行を戻す。** これが無いと、
         送信中に落ちた行は誰にも拾われず、再試行もされないまま残る。
    */
    const reclaimed = await this.outbox.reclaimStale({
      staleBefore: new Date(now.getTime() - STALE_AFTER_MS),
      now,
    });
    if (reclaimed > 0) {
      this.logger.warn({ reclaimed }, '送信中のまま取り残された知らせを戻しました');
    }

    const batch = await this.outbox.claimBatch({ limit, now });
    let sent = 0;
    let skipped = 0;
    let failed = 0;

    for (const record of batch) {
      const outcome = await this.deliverOne(record);
      if (outcome === 'sent') sent += 1;
      else if (outcome === 'skipped') skipped += 1;
      else failed += 1;
    }

    return { picked: batch.length, sent, skipped, failed };
  }

  /** 1 通ぶん。⚠️ **決して例外を投げない。** 投げると後ろの行が止まる。 */
  private async deliverOne(record: NotificationRecord): Promise<'sent' | 'skipped' | 'failed'> {
    const now = this.clock.now();

    let resolution;
    try {
      resolution = await this.recipients.resolve(record.accountId);
    } catch {
      // ⚠️ 例外の中身を見ない。宛先が混ざりうる。
      resolution = { kind: 'unavailable' as const };
    }

    if (resolution.kind === 'unknown') {
      /*
        ⚠️ **失敗にしない。** 宛先が分からないのは、こちらの障害ではなく
           「その方には送れない」という事実。失敗として数えると、
           監視が鳴りっぱなしになり、本当の障害が埋もれる。
      */
      await this.outbox.markSkipped({
        id: record.id,
        reasonCode: 'recipient_unknown',
        now,
      });
      return 'skipped';
    }

    if (resolution.kind === 'unavailable') {
      // ⚠️ 時間をおけば直りうる。再試行へ回す。
      await this.failOne(record, 'recipient_unavailable', now);
      return 'failed';
    }

    const email = resolution.email;
    const outcome = await this.mailer.send({
      to: email,
      subject: record.renderedSubject,
      body: record.renderedBody,
      /*
        ⚠️ **行の識別子から作る。再試行で変えない。** 変えると、
           送信事業者から見て別の依頼になり、同じ知らせが 2 通届く。
      */
      idempotencyKey: `ntf_${record.id}`,
    });

    const decision = decideNotification(outcome, {
      attemptCount: record.attemptCount,
      maxAttempts: record.maxAttempts || NOTIFICATION_MAX_ATTEMPTS,
    });

    if (decision.next === 'SENT') {
      await this.outbox.markSent({
        id: record.id,
        providerMessageId: decision.providerMessageId,
        // ⚠️ ここで初めて伏せる。平文は DB へ渡さない。
        maskedRecipient: maskEmail(email),
        recipientHash: this.emailHash.hash(email),
        now,
      });
      await this.audit.record({
        actorAccountId: null,
        action: 'notification.sent',
        targetType: 'notification',
        targetId: record.id,
        /*
          ⚠️ **宛先も本文も残さない。** 監査ログは運営が広く読むもので、
             ここへ入れると閲覧できる人の範囲がそのまま漏れ口になる。
        */
        summary: { eventType: record.eventType, templateVersion: record.templateVersion },
      });
      return 'sent';
    }

    if (decision.next === 'PENDING') {
      await this.outbox.recordFailure({
        id: record.id,
        status: 'PENDING',
        nextRetryAt: new Date(now.getTime() + decision.retryAfterMs),
        errorCode: decision.errorCode,
        errorMessage: null,
        now,
      });
      return 'failed';
    }

    await this.outbox.recordFailure({
      id: record.id,
      status: decision.next,
      nextRetryAt: now,
      errorCode: decision.errorCode,
      errorMessage: null,
      now,
    });
    /*
      ⚠️ **打ち切りは黙って終わらせない。** 「送ったつもり」で誰も気づかない
         まま残るのが、この手の仕組みでいちばんよくある壊れ方である。
    */
    this.logger.error(
      { eventType: record.eventType, code: decision.errorCode, next: decision.next },
      '知らせを送れませんでした',
    );
    await this.audit.record({
      actorAccountId: null,
      action: 'notification.give_up',
      targetType: 'notification',
      targetId: record.id,
      summary: { eventType: record.eventType, code: decision.errorCode, status: decision.next },
    });
    return 'failed';
  }

  /** 宛先を取り出せなかったときの再試行。⚠️ 送信の失敗と同じ扱いにする。 */
  private async failOne(record: NotificationRecord, errorCode: string, now: Date): Promise<void> {
    const decision = decideNotification(
      { kind: 'network' },
      {
        attemptCount: record.attemptCount,
        maxAttempts: record.maxAttempts || NOTIFICATION_MAX_ATTEMPTS,
      },
    );
    await this.outbox.recordFailure({
      id: record.id,
      status:
        decision.next === 'PENDING' ? 'PENDING' : decision.next === 'DEAD' ? 'DEAD' : 'FAILED',
      nextRetryAt:
        decision.next === 'PENDING' ? new Date(now.getTime() + decision.retryAfterMs) : now,
      errorCode,
      errorMessage: null,
      now,
    });
  }
}
