import { Inject, Injectable } from '@nestjs/common';
import {
  renderTemplate,
  subjectTypeOf,
  type ClockPort,
  type IdGeneratorPort,
  type NotificationEventType,
  type NotificationOutboxPort,
  type NotificationTemplateRepository,
} from '@sengoku/domain';
import type { Logger } from '@sengoku/observability';

export const NOTIFICATION_CONFIG = Symbol('sengoku:notification-config');

export interface NotificationConfig {
  /**
   * 知らせを**作る**か。
   *
   * ⚠️ **送るかどうかとは別の軸。** まとめると、送信だけ止めたい場面で
   * 生成まで止まり、止めていたあいだの注文が永久に知らされなくなる。
   */
  readonly generationEnabled: boolean;
  /** 文面の差し込みで使う事業者名。 */
  readonly siteName: string;
  /** 文面の差し込みで使う入口の URL。⚠️ 末尾のスラッシュを含めない。 */
  readonly siteUrl: string;
}

/** 積むときの入力。⚠️ 個人情報を `values` へ入れない（差し込み語彙で閉じてある）。 */
export interface EnqueueNotificationInput {
  readonly eventType: NotificationEventType;
  readonly subjectId: string;
  readonly accountId: string;
  readonly values: Readonly<Record<string, string>>;
  readonly correlationId?: string | null;
}

/**
 * 購入者への知らせを積む（P0-4）。
 *
 * ⚠️ **このクラスは決して例外を投げない。** 呼び出し元は注文・決済・返金の
 * トランザクションの中にいる。知らせが積めないことを理由にそこを巻き戻すと、
 * **決済は通っているのに注文が立たない**という、いちばん困る形になる。
 * 積めなかったことはログと件数で残し、業務側は先へ進める。
 *
 * ⚠️ **文面はここで確定させる。** 送るたびに組み立て直すと、そのあいだに
 * 文面を直した場合、同じ知らせなのに 1 通目と 2 通目で内容が変わる。
 */
@Injectable()
export class NotificationService {
  constructor(
    private readonly templates: NotificationTemplateRepository,
    private readonly outbox: NotificationOutboxPort,
    private readonly ids: IdGeneratorPort,
    private readonly clock: ClockPort,
    private readonly logger: Logger,
    @Inject(NOTIFICATION_CONFIG) private readonly config: NotificationConfig,
  ) {}

  /**
   * 送信待ちへ積む。
   *
   * @param executor 業務更新と同一トランザクションで積むためのクライアント。
   *                 ⚠️ 省略すると別トランザクションになる。**業務更新と
   *                 一緒に積める場所では必ず渡すこと。**
   * @returns 積んだかどうか。⚠️ **失敗しても例外にしない。**
   */
  async enqueue(
    input: EnqueueNotificationInput,
    executor?: Parameters<NotificationOutboxPort['enqueue']>[1],
  ): Promise<'created' | 'duplicate' | 'skipped'> {
    if (!this.config.generationEnabled) {
      return 'skipped';
    }

    try {
      const template = await this.templates.findPublished(input.eventType);
      if (template === null) {
        /*
          ⚠️ **既定の文面へ落とさない。** 落とすと、文面を下書きへ戻した
             つもりの運営に気づかれないまま送られ続ける。
        */
        this.logger.warn(
          { eventType: input.eventType },
          '文面が公開されていないため、知らせを積みませんでした',
        );
        return 'skipped';
      }

      const rendered = renderTemplate(template, {
        siteName: this.config.siteName,
        siteUrl: this.config.siteUrl,
        ...input.values,
      });
      if (!rendered.ok) {
        // ⚠️ 空欄のまま送らない。差し込む値が足りないのは、こちらの不具合。
        this.logger.error(
          { eventType: input.eventType, code: rendered.error.code },
          '差し込む値が足りないため、知らせを積みませんでした',
        );
        return 'skipped';
      }

      const outcome = await this.outbox.enqueue(
        {
          id: this.ids.generate(),
          eventType: input.eventType,
          subjectType: subjectTypeOf(input.eventType),
          subjectId: input.subjectId,
          accountId: input.accountId,
          renderedSubject: rendered.value.subject,
          renderedBody: rendered.value.body,
          templateVersion: template.version,
          correlationId: input.correlationId ?? null,
          now: this.clock.now(),
        },
        executor,
      );
      return outcome.kind;
    } catch (error) {
      /*
        ⚠️ **ここで握りつぶす。** 知らせが届かないのは困るが、
           決済が通っているのに注文が立たないほうがはるかに困る。
        ⚠️ 例外の中身をそのまま出さない。宛先や本文が混ざりうる。
      */
      this.logger.error(
        {
          eventType: input.eventType,
          error: error instanceof Error ? error.name : 'unknown',
        },
        '知らせを積めませんでした（業務処理は続行します）',
      );
      return 'skipped';
    }
  }
}
