import type {
  NotificationEventType,
  NotificationTemplateRecord,
  NotificationTemplateRepository,
  NotificationTemplateStatus,
} from '@sengoku/domain';
import type { PrismaClient } from '../../generated/client';

/**
 * 知らせの文面の永続化（P0-4）。
 *
 * ⚠️ **公開済みの版を更新する口を持たない。** 直すときは新しい版を作る。
 * 更新できるようにすると、送信履歴が指している版の中身が変わり、
 * 「そのとき何と書いて送ったか」を誰も答えられなくなる。
 *
 * ⚠️ **削除の口も持たない。**
 */
export class PrismaNotificationTemplateRepository implements NotificationTemplateRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * その種別で**いま有効な**版。公開済みのうち最新。
   *
   * ⚠️ **無ければ `null`。既定の文面へ落とさない。** 落とすと、文面を
   * 下書きへ戻したつもりの運営に気づかれないまま送られ続ける。
   */
  async findPublished(
    eventType: NotificationEventType,
  ): Promise<NotificationTemplateRecord | null> {
    const row = await this.prisma.notificationTemplate.findFirst({
      where: { eventType, status: 'published' },
      orderBy: [{ version: 'desc' }],
    });
    return row === null ? null : toRecord(row);
  }

  async listAll(): Promise<readonly NotificationTemplateRecord[]> {
    /*
      ⚠️ **種別ごとに最新版だけを返す、という絞り込みをここでしない。**
         一覧は「いまどうなっているか」を人が見るためのもので、
         下書きが 1 件あることも知りたい情報である。
    */
    const rows = await this.prisma.notificationTemplate.findMany({
      orderBy: [{ eventType: 'asc' }, { version: 'desc' }],
    });
    return rows.map(toRecord);
  }

  async listVersions(
    eventType: NotificationEventType,
  ): Promise<readonly NotificationTemplateRecord[]> {
    const rows = await this.prisma.notificationTemplate.findMany({
      where: { eventType },
      orderBy: [{ version: 'desc' }],
    });
    return rows.map(toRecord);
  }

  /**
   * 新しい版を作る。
   *
   * ⚠️ **採番を「読んでから書く」で行っている。** 同じ種別へ同時に
   * 版を作ると片方が UNIQUE 違反で落ちるが、これは正しい振る舞い——
   * 運営が 2 人で同じ文面を同時に直したときは、後の人に気づいてほしい。
   * 黙って両方通すと、片方の編集が消える。
   */
  async createVersion(input: {
    readonly eventType: NotificationEventType;
    readonly subject: string;
    readonly body: string;
    readonly status: NotificationTemplateStatus;
    readonly actorAccountId: string | null;
    readonly now: Date;
  }): Promise<NotificationTemplateRecord> {
    const latest = await this.prisma.notificationTemplate.findFirst({
      where: { eventType: input.eventType },
      orderBy: [{ version: 'desc' }],
      select: { version: true },
    });
    const version = (latest?.version ?? 0) + 1;

    const row = await this.prisma.notificationTemplate.create({
      data: {
        eventType: input.eventType,
        version,
        subject: input.subject,
        body: input.body,
        status: input.status,
        // ⚠️ 「公開した」と「公開した時刻」を必ず同時に立てる（CHECK と同じ規則）。
        publishedAt: input.status === 'published' ? input.now : null,
        createdByAccountId: input.actorAccountId,
        createdAt: input.now,
        updatedAt: input.now,
      },
    });
    return toRecord(row);
  }

  /** 下書きを公開する。⚠️ 条件付き更新。すでに公開済みなら何もしない。 */
  async publish(input: {
    readonly eventType: NotificationEventType;
    readonly version: number;
    readonly actorAccountId: string | null;
    readonly now: Date;
  }): Promise<boolean> {
    const updated = await this.prisma.notificationTemplate.updateMany({
      where: { eventType: input.eventType, version: input.version, status: 'draft' },
      data: { status: 'published', publishedAt: input.now, updatedAt: input.now },
    });
    return updated.count === 1;
  }
}

function toRecord(row: {
  eventType: string;
  version: number;
  subject: string;
  body: string;
  status: string;
  publishedAt: Date | null;
  updatedAt: Date;
}): NotificationTemplateRecord {
  return {
    // ⚠️ DB の CHECK で語彙を縛ってある。ここで既定へ倒さない。
    eventType: row.eventType as NotificationEventType,
    version: row.version,
    subject: row.subject,
    body: row.body,
    status: row.status as NotificationTemplateStatus,
    publishedAt: row.publishedAt,
    updatedAt: row.updatedAt,
  };
}
