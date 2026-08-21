import type {
  NotificationEventType,
  NotificationHistoryPage,
  NotificationHistoryPort,
  NotificationHistoryQuery,
  NotificationHistoryRecord,
  NotificationStatus,
  NotificationSubjectType,
} from '@sengoku/domain';
import type { PrismaClient } from '../../generated/client';
import { decodeCursor, encodeCursor } from './mappers';

/**
 * 送信履歴を読む口（P0-4「管理画面から送信履歴を確認できる」）。
 *
 * ⚠️ **送る口と分けてある。** あちらは本文と宛先を扱い、こちらは人が
 * 眺めるためのもの。ひとつにまとめると、画面側の書き忘れ 1 行で
 * 本文や宛先が表に出る。**返す型そのものを分けておけば、書き忘れようがない。**
 *
 * ⚠️ **本文（`rendered_body`）を返さない。** 一覧に本文は要らない。
 * 要るのは「いつ・誰に・どの知らせを・送れたか」まで。
 */
export class PrismaNotificationHistoryRepository implements NotificationHistoryPort {
  constructor(private readonly prisma: PrismaClient) {}

  async list(query: NotificationHistoryQuery): Promise<NotificationHistoryPage> {
    const cursor = decodeCursor(query.cursor);
    const rows = await this.prisma.notificationDelivery.findMany({
      where: {
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.eventType === undefined ? {} : { eventType: query.eventType }),
        ...(query.subjectId === undefined ? {} : { subjectId: query.subjectId }),
        ...(cursor === null
          ? {}
          : {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      // ⚠️ 1 件多く取り、次があるかを判定する。件数を数え直さない。
      take: query.limit + 1,
      select: HISTORY_SELECT,
    });

    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toRecord),
      nextCursor:
        rows.length > query.limit && last !== undefined
          ? encodeCursor({ createdAt: last.createdAt, id: last.id })
          : null,
    };
  }

  async findById(id: string): Promise<NotificationHistoryRecord | null> {
    const row = await this.prisma.notificationDelivery.findUnique({
      where: { id },
      select: HISTORY_SELECT,
    });
    return row === null ? null : toRecord(row);
  }
}

/**
 * 持ち出してよい列。
 *
 * ⚠️ **`rendered_body` と `recipient_hash` を入れない。** 前者は本文、
 * 後者は照合用の値で、どちらも画面に出す理由が無い。
 */
const HISTORY_SELECT = {
  id: true,
  eventType: true,
  subjectType: true,
  subjectId: true,
  maskedRecipient: true,
  templateVersion: true,
  renderedSubject: true,
  status: true,
  attemptCount: true,
  lastErrorCode: true,
  skippedReasonCode: true,
  sentAt: true,
  createdAt: true,
} as const;

function toRecord(row: {
  id: string;
  eventType: string;
  subjectType: string;
  subjectId: string;
  maskedRecipient: string | null;
  templateVersion: number;
  renderedSubject: string;
  status: string;
  attemptCount: number;
  lastErrorCode: string | null;
  skippedReasonCode: string | null;
  sentAt: Date | null;
  createdAt: Date;
}): NotificationHistoryRecord {
  return {
    id: row.id,
    eventType: row.eventType as NotificationEventType,
    subjectType: row.subjectType as NotificationSubjectType,
    subjectId: row.subjectId,
    maskedRecipient: row.maskedRecipient,
    templateVersion: row.templateVersion,
    subject: row.renderedSubject,
    status: row.status as NotificationStatus,
    attemptCount: row.attemptCount,
    lastErrorCode: row.lastErrorCode,
    skippedReasonCode: row.skippedReasonCode,
    sentAt: row.sentAt,
    createdAt: row.createdAt,
  };
}

/**
 * 認証基盤での本人の識別子を引く（P0-4）。
 *
 * ⚠️ **`accounts.auth_subject` を返すだけ。** メールアドレスはここには無い
 * （`UD-503`）。宛先の取り出しは、この識別子を使って認証基盤へ問い合わせる
 * 側の仕事で、**この口は平文へ一切触れない**。
 */
export class PrismaAuthSubjectLookup {
  constructor(private readonly prisma: PrismaClient) {}

  async findAuthSubject(accountId: string): Promise<string | null> {
    const row = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: { authSubject: true, status: true },
    });
    if (row === null) {
      return null;
    }
    /*
      ⚠️ **停止中の方へ送らない。** 停止したのに知らせだけ届き続けるのは、
         受け取った方から見ると「何が起きているのか分からない」状態になる。
    */
    if (row.status !== 'active') {
      return null;
    }
    return row.authSubject;
  }
}
