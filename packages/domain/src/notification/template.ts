import { domainError, type DomainError } from '../shared/errors';
import { err, ok, type Result } from '../shared/result';
import { allowedVariables, type NotificationEventType } from './events';

/**
 * 知らせの文面（テンプレート）。
 *
 * ⚠️ **文面をコードへ書かない**（指示書 P0-4）。書くと、直すたびに
 * デプロイが要る。文言の直しは運営が最も頻繁に行うことで、そのたびに
 * 開発を待つ運用は続かない。
 *
 * ⚠️ **公開した版は書き換えない。** 法務文書と同じ理由で、「そのとき
 * 何と書いて送ったか」を後から示せる必要がある。直すときは新しい版を作る。
 *
 * ⚠️ **削除の口を作らない。** 送信履歴が参照している版が消えると、
 * 過去に何を送ったのか復元できなくなる。
 */

export const NOTIFICATION_TEMPLATE_STATUSES = ['draft', 'published'] as const;
export type NotificationTemplateStatus = (typeof NOTIFICATION_TEMPLATE_STATUSES)[number];

/** 差し込みの記法。⚠️ 空白は許すが、語そのものに空白は含めない。 */
const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g;

/** 件名の上限。長すぎる件名は受信側で切られ、用件が消える。 */
export const NOTIFICATION_SUBJECT_MAX = 120;
/** 本文の上限。⚠️ 上限が無いと、貼り付け事故がそのまま全員へ届く。 */
export const NOTIFICATION_BODY_MAX = 8000;

export interface NotificationTemplateDraft {
  readonly eventType: NotificationEventType;
  readonly subject: string;
  readonly body: string;
}

/**
 * テンプレートに書かれている差し込み語を集める。
 *
 * ⚠️ 重複は畳む。同じ語を 2 回書くのは普通のこと。
 */
export function referencedVariables(text: string): readonly string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(PLACEHOLDER)) {
    const name = match[1];
    if (name !== undefined) {
      found.add(name);
    }
  }
  return [...found].sort();
}

/**
 * 公開してよいテンプレートかを判定する。
 *
 * ⚠️ **公開の時点で弾く。送る時点ではない。** 送る時点で気づいても、
 * そのときには送るはずだった知らせが止まっているだけで、
 * 直せるのは次の 1 通からになる。**書いた人がその場で気づける**ようにする。
 */
export function validateTemplate(draft: NotificationTemplateDraft): Result<true, DomainError> {
  const subject = draft.subject.trim();
  const body = draft.body.trim();

  if (subject.length === 0) {
    return err(domainError('NOTIFICATION_TEMPLATE_INVALID', 'subject is required'));
  }
  if (subject.length > NOTIFICATION_SUBJECT_MAX) {
    return err(domainError('NOTIFICATION_TEMPLATE_INVALID', 'subject is too long'));
  }
  if (body.length === 0) {
    return err(domainError('NOTIFICATION_TEMPLATE_INVALID', 'body is required'));
  }
  if (body.length > NOTIFICATION_BODY_MAX) {
    return err(domainError('NOTIFICATION_TEMPLATE_INVALID', 'body is too long'));
  }
  /*
    ⚠️ **件名に改行を入れさせない。** ヘッダへ改行が入ると、そこから先を
       別のヘッダとして解釈されうる。文面の都合ではなく、送信の安全の話。
  */
  if (/[\r\n]/.test(draft.subject)) {
    return err(domainError('NOTIFICATION_TEMPLATE_INVALID', 'subject must be single line'));
  }

  const allowed = new Set(allowedVariables(draft.eventType));
  const used = [...referencedVariables(subject), ...referencedVariables(body)];
  const unknown = used.filter((name) => !allowed.has(name));
  if (unknown.length > 0) {
    return err(
      domainError(
        'NOTIFICATION_TEMPLATE_UNKNOWN_VARIABLE',
        `unknown variables: ${unknown.join(', ')}`,
      ),
    );
  }
  return ok(true);
}

export interface RenderedNotification {
  readonly subject: string;
  readonly body: string;
}

/**
 * 文面へ値を差し込む。
 *
 * ⚠️ **値が足りなければ落とす。空文字で埋めない。** 埋めてしまうと
 * 「ご注文番号 」という知らせが届く。届いた側は何のことか分からず、
 * こちらは送ったことに気づかない。
 *
 * ⚠️ **差し込む値を再帰的に展開しない。** 値の中に `{{ }}` があっても
 * そのまま出す。展開すると、作品名に書かれた文字列が差し込み語として
 * 働き、他の値を引き出せる。
 */
export function renderTemplate(
  template: NotificationTemplateDraft,
  values: Readonly<Record<string, string>>,
): Result<RenderedNotification, DomainError> {
  const missing = new Set<string>();

  const substitute = (text: string): string =>
    text.replace(PLACEHOLDER, (_whole, name: string) => {
      const value = values[name];
      if (value === undefined) {
        missing.add(name);
        return '';
      }
      return value;
    });

  const subject = substitute(template.subject);
  const body = substitute(template.body);

  if (missing.size > 0) {
    return err(
      domainError(
        'NOTIFICATION_RENDER_INCOMPLETE',
        `missing values: ${[...missing].sort().join(', ')}`,
      ),
    );
  }
  return ok({ subject, body });
}
