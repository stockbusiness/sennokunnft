import type { MailAttemptOutcome, NotificationStatus } from '../notification/dispatch';
import type { NotificationEventType, NotificationSubjectType } from '../notification/events';
import type { NotificationTemplateStatus } from '../notification/template';
import type { RecipientResolution } from '../notification/recipient';

/**
 * 購入者への知らせ（実運営 指示書 P0-4）。
 *
 * ⚠️ **積むのは業務更新と同じトランザクション。送るのはコミットのあと。**
 * 先に送ると、そのあと業務側が巻き戻ったときに「起きていないこと」を
 * 知らせてしまう。あとから積むと、そのあいだに落ちた注文が
 * **誰にも知らされないまま**残る。
 *
 * ⚠️ **送信の失敗で業務処理を失敗させない。** 知らせが届かないのは困るが、
 * 決済が通っているのに注文が立たないほうがはるかに困る。
 */

/** 送信待ち 1 通ぶん。⚠️ 宛先の平文は持たない。 */
export interface NotificationRecord {
  readonly id: string;
  readonly eventType: NotificationEventType;
  readonly subjectType: NotificationSubjectType;
  readonly subjectId: string;
  /** 宛先の本人。⚠️ アドレスは送信時に取り直す。 */
  readonly accountId: string;
  /** 送るときに使う件名。⚠️ 積んだ時点で確定させ、以後は作り直さない。 */
  readonly renderedSubject: string;
  readonly renderedBody: string;
  /** 焼き付けたテンプレートの版。 */
  readonly templateVersion: number;
  readonly status: NotificationStatus;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly correlationId: string | null;
}

/**
 * 積むときの入力。
 *
 * ⚠️ **`eventType` と `subjectId` の組で一意。** 同じ Webhook が 2 度
 * 届いても、2 通目は積まれない（DB の UNIQUE が最後の砦）。
 */
export interface NotificationEnqueueInput {
  readonly id: string;
  readonly eventType: NotificationEventType;
  readonly subjectType: NotificationSubjectType;
  readonly subjectId: string;
  readonly accountId: string;
  readonly renderedSubject: string;
  readonly renderedBody: string;
  readonly templateVersion: number;
  readonly correlationId: string | null;
  readonly now: Date;
}

/** 積んだ結果。⚠️ 「すでにあった」を失敗にしない。 */
export type NotificationEnqueueOutcome =
  | { readonly kind: 'created'; readonly id: string }
  /** 同じ知らせが既に積まれている。**冪等成功。** */
  | { readonly kind: 'duplicate'; readonly id: string };

export interface NotificationFailureInput {
  readonly id: string;
  readonly status: Extract<NotificationStatus, 'PENDING' | 'FAILED' | 'DEAD'>;
  readonly nextRetryAt: Date;
  readonly errorCode: string;
  /** ⚠️ 送信事業者の応答本文をそのまま入れない。 */
  readonly errorMessage: string | null;
  readonly now: Date;
}

export interface NotificationOutboxPort {
  /**
   * 送信待ちへ積む。⚠️ **業務更新と同一トランザクションで呼ぶ。**
   *
   * ⚠️ **UNIQUE 違反を例外にしない。** 例外にすると、重複した Webhook
   * 1 通で業務側のトランザクションごと巻き戻る。
   */
  enqueue(
    input: NotificationEnqueueInput,
    /**
     * 業務更新と同一トランザクションで積むための口。
     *
     * ⚠️ **型を `unknown` にしてある。** ここへ Prisma の型を書くと、
     * ドメインが特定の DB 実装を知ることになる。渡す側と受ける側の
     * 実装だけが中身を知っていればよい。
     */
    executor?: unknown,
  ): Promise<NotificationEnqueueOutcome>;

  /**
   * 送る対象を排他的に掴み、`PROCESSING` へ進めて試行回数を加算する。
   *
   * ⚠️ 「探してから書く」実装にしない。複数のワーカーが同じ行を掴み、
   * **同じ知らせが 2 通届く**。
   */
  claimBatch(input: { readonly limit: number; readonly now: Date }): Promise<NotificationRecord[]>;

  markSent(input: {
    readonly id: string;
    readonly providerMessageId: string | null;
    readonly maskedRecipient: string;
    readonly recipientHash: string | null;
    readonly now: Date;
  }): Promise<boolean>;

  recordFailure(input: NotificationFailureInput): Promise<boolean>;

  /**
   * 送らずに閉じる。⚠️ **失敗として数えない。**
   */
  markSkipped(input: {
    readonly id: string;
    readonly reasonCode: string;
    readonly now: Date;
  }): Promise<boolean>;

  /** `PROCESSING` のまま取り残された行を戻す。⚠️ 無いと永久に止まる。 */
  reclaimStale(input: { readonly staleBefore: Date; readonly now: Date }): Promise<number>;

  /** 手動再送。`FAILED` / `DEAD` のみ。⚠️ 本文は作り直さない。 */
  requeue(input: { readonly id: string; readonly now: Date }): Promise<boolean>;
}

/** 文面の 1 版。 */
export interface NotificationTemplateRecord {
  readonly eventType: NotificationEventType;
  readonly version: number;
  readonly subject: string;
  readonly body: string;
  readonly status: NotificationTemplateStatus;
  readonly publishedAt: Date | null;
  readonly updatedAt: Date;
}

export interface NotificationTemplateRepository {
  /**
   * その種別で**いま有効な**版を返す。⚠️ 公開済みのうち最新。
   *
   * 無ければ `null`。⚠️ **既定の文面へ落とさない。** 落とすと、
   * 文面を消したつもりの運営に気づかれないまま送られ続ける。
   */
  findPublished(eventType: NotificationEventType): Promise<NotificationTemplateRecord | null>;

  listAll(): Promise<readonly NotificationTemplateRecord[]>;

  listVersions(eventType: NotificationEventType): Promise<readonly NotificationTemplateRecord[]>;

  /**
   * 新しい版を作る。⚠️ **既存の版は書き換えない。**
   *
   * @returns 採番された版
   */
  createVersion(input: {
    readonly eventType: NotificationEventType;
    readonly subject: string;
    readonly body: string;
    readonly status: NotificationTemplateStatus;
    readonly actorAccountId: string | null;
    readonly now: Date;
  }): Promise<NotificationTemplateRecord>;

  /** 下書きを公開する。⚠️ 公開済みの版は対象外。 */
  publish(input: {
    readonly eventType: NotificationEventType;
    readonly version: number;
    readonly actorAccountId: string | null;
    readonly now: Date;
  }): Promise<boolean>;
}

/**
 * 宛先を取り出す口。
 *
 * ⚠️ **戻り値を保存しない。** 送信の 1 回ぶんだけ使い、捨てる（`UD-503`）。
 * ⚠️ **実装は引数も戻り値もログへ出さない。**
 */
export interface RecipientResolverPort {
  resolve(accountId: string): Promise<RecipientResolution>;
}

/**
 * メールを送る口。
 *
 * ⚠️ **実装は宛先をログへ出さない。** 失敗したときほど出したくなるが、
 * そこが平文アドレスの最大の漏れ口になる。分類コードと件名までにする。
 */
export interface MailSenderPort {
  send(input: {
    readonly to: string;
    readonly subject: string;
    readonly body: string;
    /** 送信事業者側の重複防止。⚠️ 再試行で作り直さない。 */
    readonly idempotencyKey: string;
  }): Promise<MailAttemptOutcome>;
}

/** 送信履歴の 1 行（運営が読む）。⚠️ 平文の宛先を持ち出さない。 */
export interface NotificationHistoryRecord {
  readonly id: string;
  readonly eventType: NotificationEventType;
  readonly subjectType: NotificationSubjectType;
  readonly subjectId: string;
  readonly maskedRecipient: string | null;
  readonly templateVersion: number;
  readonly subject: string;
  readonly status: NotificationStatus;
  readonly attemptCount: number;
  readonly lastErrorCode: string | null;
  readonly skippedReasonCode: string | null;
  readonly sentAt: Date | null;
  readonly createdAt: Date;
}

export interface NotificationHistoryQuery {
  readonly status?: NotificationStatus | undefined;
  readonly eventType?: NotificationEventType | undefined;
  readonly subjectId?: string | undefined;
  readonly limit: number;
  readonly cursor?: string | undefined;
}

export interface NotificationHistoryPage {
  readonly items: readonly NotificationHistoryRecord[];
  readonly nextCursor: string | null;
}

/**
 * 送信履歴を読む口。
 *
 * ⚠️ **送る口と分けてある。** あちらは本文と宛先を扱い、こちらは
 * 人が眺めるためのもの。ひとつにまとめると、画面側の書き忘れ 1 行で
 * 宛先が表に出る。**型そのものを分けておけば、書き忘れようがない。**
 */
export interface NotificationHistoryPort {
  list(query: NotificationHistoryQuery): Promise<NotificationHistoryPage>;
  findById(id: string): Promise<NotificationHistoryRecord | null>;
}
