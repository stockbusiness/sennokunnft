import { ForbiddenException, Injectable } from '@nestjs/common';
import type { MailCheckResponse } from '@sengoku/contracts';
import type { Actor } from '@sengoku/auth';
import {
  maskEmail,
  type AuditLogPort,
  type ClockPort,
  type IntegrationEnvironment,
  type MailAttemptOutcome,
  type StaffMemberRepository,
} from '@sengoku/domain';
import type { ConnectionCheckKind, IntegrationService } from '@sengoku/domain';
import { DomainErrorException } from '../common/domain-error.filter';

/**
 * メールの試し送り（実運営 指示書 P0-7 の 6 番目）。
 *
 * **本番販売の前に、送信経路が生きていることを確かめる必要がある。**
 * 到達性の確認（`reachability`）では足りない。api.resend.com へ届くことは、
 * 鍵が正しいことも差出人が確認済みであることも意味しない。
 *
 * ⚠️ **宛先は、押した本人の業務用アドレスに限る。** 宛先を受け取る形に
 * すると、この口が「任意の相手へメールを送れる口」になる。誰の手元にも
 * 届かないから、試し送りが安全でいられる。
 *
 * ⚠️ **平文の宛先を返さない・記録しない・ログへ出さない**（`UD-503`）。
 * 応答へ載せるのは伏せた表記だけ。
 *
 * ⚠️ **この試し送りを OVEW Wallet へ広げない。** あちらの受け口は
 * 受取権を作る口で、試し打ちしてよい相手ではない（要決定 06 は未解決）。
 */

/**
 * 確かめた結果を残す口。
 *
 * ⚠️ **外部連携の設定一式ではなく、記録する口だけを要求する。** あちらは
 * 暗号鍵を持たない配備には存在しない（`IntegrationService_` は条件付き
 * provider）。丸ごと必須にすると、鍵の無い配備で**起動そのものが落ちる**
 * ——実際に e2e がそれで落ちた。
 */
export interface ConnectionCheckRecorder {
  recordCheck(input: {
    readonly service: IntegrationService;
    readonly environment: IntegrationEnvironment;
    readonly kind: ConnectionCheckKind;
    readonly succeeded: boolean;
    readonly failureCode: string | null;
    readonly httpStatus: number | null;
    readonly durationMs: number;
    readonly secretId: string | null;
    readonly actorAccountId: string;
    readonly correlationId: string | null;
  }): Promise<unknown>;
}

/** 試し送りの手段。⚠️ 持たない配備では `null`。 */
export interface MailTestSender {
  send(input: {
    readonly to: string;
    readonly subject: string;
    readonly body: string;
    readonly idempotencyKey: string;
  }): Promise<MailAttemptOutcome>;
}

const SUBJECT = '【千ノ国】メール送信の試し送り';

const BODY = [
  'この本文は、メールの送信経路が生きていることを確かめるために送られました。',
  '',
  'お心当たりが無い場合は、運営までお知らせください。',
  '',
  '⚠️ このメールに、ご注文やお客さまの情報は含まれていません。',
].join('\n');

@Injectable()
export class MailCheckService {
  constructor(
    /**
     * ⚠️ **`null` は「この配備では確かめられない」。** 記録できない試し送りは
     * 意味が無い——本番販売ガードが読むのは、送った事実ではなく**記録**だから。
     */
    private readonly integrations: ConnectionCheckRecorder | null,
    private readonly staff: StaffMemberRepository,
    private readonly clock: ClockPort,
    private readonly audit: AuditLogPort,
    private readonly environment: IntegrationEnvironment,
    /**
     * ⚠️ **`null` は「この配備では送れない」。** 口は生やして、押されたら
     * 断る。口ごと消すと、画面が配備ごとに変わる。
     */
    private readonly sender: MailTestSender | null = null,
  ) {}

  async run(actor: Actor): Promise<MailCheckResponse> {
    const accountId = actor.accountId;
    if (accountId === null) {
      // ⚠️ ここへ来るのは配線の誤り。認可ガードが先に弾いている。
      throw new ForbiddenException();
    }
    /*
      ⚠️ **送れないことと、記録できないことを同じ扱いにする。** 記録の残らない
         試し送りは、本番販売ガードから見れば「やっていない」のと変わらない。
    */
    if (this.sender === null || this.integrations === null) {
      throw new DomainErrorException('MAIL_UNAVAILABLE');
    }

    /*
      ⚠️ **宛先を引数で受け取らない。** 押した本人の業務用アドレスだけ。
         受け取る形にすると、この口が「任意の相手へメールを送れる口」になる。
    */
    const member = await this.staff.findById(accountId);
    const to = member?.staffEmail ?? null;
    if (to === null || to === '') {
      throw new DomainErrorException('MAIL_RECIPIENT_MISSING');
    }

    const startedAt = this.clock.now();
    const outcome = await this.sender.send({
      to,
      subject: SUBJECT,
      body: BODY,
      /*
        ⚠️ **時刻を混ぜる。** 同じ鍵にすると、送信事業者が「同じ依頼」と
           見なして 2 回目以降を握りつぶす。試し送りは何度でも押せて、
           そのつど本当に送られる必要がある。
      */
      idempotencyKey: `mail-check-${accountId}-${String(startedAt.getTime())}`,
    });
    const finishedAt = this.clock.now();
    const verdict = classify(outcome);

    const recorder = this.integrations;
    await recorder.recordCheck({
      service: 'mail',
      environment: this.environment,
      // ⚠️ 到達性ではない。資格情報で実際に受け付けられたかを見ている。
      kind: 'test_send',
      succeeded: verdict.succeeded,
      failureCode: verdict.failureCode,
      httpStatus: verdict.httpStatus,
      durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      // ⚠️ 鍵はこの保管庫に無い（配備環境の環境変数）。使ったことにしない。
      secretId: null,
      actorAccountId: accountId,
      correlationId: null,
    });

    await this.audit.record({
      actorAccountId: accountId,
      action: 'production.mail_check',
      targetType: 'integration',
      targetId: 'mail',
      // ⚠️ 宛先を記録しない。伏せた表記も監査ログには要らない。
      summary: { succeeded: verdict.succeeded, failureCode: verdict.failureCode },
    });

    return {
      succeeded: verdict.succeeded,
      // ⚠️ ここから元のアドレスへは戻せない。
      maskedRecipient: maskEmail(to),
      failureCode: verdict.failureCode,
      executedAt: finishedAt.toISOString(),
    };
  }
}

/**
 * 送信事業者の返事を、記録できる形にする。
 *
 * ⚠️ **`accepted` は「受け付けた」まで。** 相手先へ届いたことは、
 * こちらには分からない。画面の言葉もそこで止める。
 */
function classify(outcome: MailAttemptOutcome): {
  readonly succeeded: boolean;
  readonly failureCode: string | null;
  readonly httpStatus: number | null;
} {
  switch (outcome.kind) {
    case 'accepted':
      return { succeeded: true, failureCode: null, httpStatus: null };
    case 'rejected':
      return { succeeded: false, failureCode: 'REJECTED', httpStatus: outcome.statusCode };
    case 'timeout':
      return { succeeded: false, failureCode: 'TIMEOUT', httpStatus: null };
    case 'network':
      return { succeeded: false, failureCode: 'NETWORK', httpStatus: null };
  }
}
