import {
  TOKUSHOHO_FIELD_KEYS,
  isLegalDocumentKind,
  type ConsentRequiredKind,
  type CreateLegalDraftCommand,
  type LegalConsentRecord,
  type LegalConsentRepository,
  type RecordConsentCommand,
  type LegalDocumentKind,
  type LegalDocumentRepository,
  type LegalDocumentVersion,
  type PublishLegalVersionCommand,
  type SaveLegalDraftCommand,
  type TokushohoFields,
} from '@sengoku/domain';

import type { PrismaClient } from '../../generated/client';

/**
 * 法務文書の版の保管庫。
 *
 * ⚠️ **書き換えは `status = 'draft'` の行にしか効かせない。** 呼び出し側の
 * 判定に頼ると、いつか判定を通らない経路（一括投入・別の画面）ができる。
 * `updateMany` の `where` に条件を入れ、0 件なら `null` を返す。
 *
 * ⚠️ **削除の関数を置かない。**
 */
export class PrismaLegalDocumentRepository implements LegalDocumentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listVersions(kind: LegalDocumentKind): Promise<readonly LegalDocumentVersion[]> {
    const rows = await this.prisma.legalDocumentVersion.findMany({
      where: { kind },
      orderBy: { version: 'desc' },
    });
    return rows.map(toDomain);
  }

  async findById(id: string): Promise<LegalDocumentVersion | null> {
    const row = await this.prisma.legalDocumentVersion.findUnique({ where: { id } });
    return row === null ? null : toDomain(row);
  }

  async findDraft(kind: LegalDocumentKind): Promise<LegalDocumentVersion | null> {
    const row = await this.prisma.legalDocumentVersion.findFirst({
      where: { kind, status: 'draft' },
    });
    return row === null ? null : toDomain(row);
  }

  async findEffective(kind: LegalDocumentKind, now: Date): Promise<LegalDocumentVersion | null> {
    /*
      ⚠️ **施行日が来ている中で、いちばん新しいもの。** 「公開済みの
         最新版」ではない。予約公開があるので、両者は一致しない。
    */
    const row = await this.prisma.legalDocumentVersion.findFirst({
      where: { kind, status: 'published', effectiveFrom: { lte: now } },
      orderBy: { effectiveFrom: 'desc' },
    });
    return row === null ? null : toDomain(row);
  }

  async create(command: CreateLegalDraftCommand): Promise<LegalDocumentVersion> {
    /*
      ⚠️ **連番は「いまある最大＋1」で採る。** 空きを詰めない。
         詰めると、公開済みの版と同じ番号を新しい下書きが名乗る。
         同時に 2 つ作られたときは `(kind, version)` の一意制約が弾き、
         下書きは種類ごとに 1 つという部分一意索引も弾く。
    */
    const latest = await this.prisma.legalDocumentVersion.findFirst({
      where: { kind: command.kind },
      orderBy: { version: 'desc' },
      select: { version: true },
    });

    const row = await this.prisma.legalDocumentVersion.create({
      data: {
        kind: command.kind,
        version: (latest?.version ?? 0) + 1,
        status: 'draft',
        title: command.title,
        bodyText: command.bodyText,
        tokushoho: command.tokushoho === null ? undefined : { ...command.tokushoho },
        createdByAccountId: command.createdByAccountId,
      },
    });
    return toDomain(row);
  }

  async saveDraft(command: SaveLegalDraftCommand): Promise<LegalDocumentVersion | null> {
    const updated = await this.prisma.legalDocumentVersion.updateMany({
      // ⚠️ 状態を条件に含める。公開済みの行に当たらないことを DB 側で保証する。
      where: { id: command.id, status: 'draft' },
      data: {
        title: command.title,
        bodyText: command.bodyText,
        tokushoho: command.tokushoho === null ? undefined : { ...command.tokushoho },
      },
    });
    if (updated.count === 0) {
      return null;
    }
    return this.findById(command.id);
  }

  async publish(command: PublishLegalVersionCommand): Promise<LegalDocumentVersion | null> {
    const updated = await this.prisma.legalDocumentVersion.updateMany({
      where: { id: command.id, status: 'draft' },
      data: {
        status: 'published',
        effectiveFrom: command.effectiveFrom,
        publishedAt: command.publishedAt,
        publishedByAccountId: command.publishedByAccountId,
        requiresReconsent: command.requiresReconsent,
      },
    });
    if (updated.count === 0) {
      return null;
    }
    return this.findById(command.id);
  }
}

interface LegalRow {
  readonly id: string;
  readonly kind: string;
  readonly version: number;
  readonly status: string;
  readonly title: string;
  readonly bodyText: string | null;
  readonly tokushoho: unknown;
  readonly effectiveFrom: Date | null;
  readonly requiresReconsent: boolean;
  readonly publishedAt: Date | null;
  readonly createdByAccountId: string;
  readonly publishedByAccountId: string | null;
  readonly createdAt: Date;
}

function toDomain(row: LegalRow): LegalDocumentVersion {
  if (!isLegalDocumentKind(row.kind)) {
    /*
      ⚠️ **知らない種類を黙って通さない。** DB の CHECK が守っているので
         ここへは来ないはずだが、来たなら CHECK が外れているということで、
         そのまま画面へ出すより止めたほうがよい。
    */
    throw new Error(`unknown legal document kind: ${row.kind}`);
  }
  return {
    id: row.id,
    kind: row.kind,
    version: row.version,
    status: row.status === 'published' ? 'published' : 'draft',
    title: row.title,
    bodyText: row.bodyText,
    tokushoho: toTokushoho(row.tokushoho),
    effectiveFrom: row.effectiveFrom,
    requiresReconsent: row.requiresReconsent,
    publishedAt: row.publishedAt,
    createdByAccountId: row.createdByAccountId,
    publishedByAccountId: row.publishedByAccountId,
    createdAt: row.createdAt,
  };
}

/**
 * JSON を項目へ戻す。
 *
 * ⚠️ **そのまま信じない。** JSONB なので、DB の CHECK では形を縛れない。
 * 欄が欠けていたら空文字にして、`missingTokushohoFields` に見つけさせる。
 * ここで例外にすると、1 欄壊れただけで管理画面ごと開かなくなり、
 * 直す手立てが無くなる。
 */
function toTokushoho(value: unknown): TokushohoFields | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const source = value as Record<string, unknown>;
  const entries = TOKUSHOHO_FIELD_KEYS.map((key) => {
    const field = source[key];
    return [key, typeof field === 'string' ? field : ''] as const;
  });
  return Object.fromEntries(entries) as unknown as TokushohoFields;
}

/**
 * 規約への同意（`UD-126`）。
 *
 * ⚠️ **書き換えも削除もしない。** 同意は起きた出来事で、あとから
 * 無かったことにはできない。この class に更新も削除も置かない。
 */
export class PrismaLegalConsentRepository implements LegalConsentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findLatestConsent(
    accountId: string,
    kind: ConsentRequiredKind,
  ): Promise<LegalConsentRecord | null> {
    const row = await this.prisma.legalConsent.findFirst({
      where: { accountId, kind },
      // ⚠️ 版番号の降順。日時ではない（同意した順と版の順は必ずしも一致しない）。
      orderBy: { version: 'desc' },
    });
    if (row === null) {
      return null;
    }
    return {
      accountId: row.accountId,
      kind,
      versionId: row.versionId,
      version: row.version,
      consentedAt: row.consentedAt,
    };
  }

  async hasPendingReconsent(
    kind: ConsentRequiredKind,
    consentedVersion: number,
    now: Date,
  ): Promise<boolean> {
    /*
      ⚠️ **「新しい版があるか」を見ない。** 印が立っている版だけを見る。
         誤字を直しただけの改定で全員を止めると、同意の画面が
         「とりあえず押すもの」になる。
      ⚠️ 施行日が来ているものに限る。予約公開の版で先に止めない。
    */
    const count = await this.prisma.legalDocumentVersion.count({
      where: {
        kind,
        status: 'published',
        requiresReconsent: true,
        version: { gt: consentedVersion },
        effectiveFrom: { lte: now },
      },
    });
    return count > 0;
  }

  async recordConsent(command: RecordConsentCommand): Promise<LegalConsentRecord> {
    /*
      ⚠️ **二度押しで増やさない。** `(account_id, version_id)` の一意制約が
         あるので、既にあれば何もしない。日時は最初の 1 回を残す。
         あとから上書きすると「いつ同意したのか」が動く。
    */
    await this.prisma.legalConsent.upsert({
      where: {
        accountId_versionId: {
          accountId: command.accountId,
          versionId: command.versionId,
        },
      },
      update: {},
      create: {
        accountId: command.accountId,
        kind: command.kind,
        versionId: command.versionId,
        version: command.version,
        consentedAt: command.consentedAt,
      },
    });

    const stored = await this.prisma.legalConsent.findUnique({
      where: {
        accountId_versionId: {
          accountId: command.accountId,
          versionId: command.versionId,
        },
      },
    });
    if (stored === null) {
      throw new Error('consent row disappeared after upsert');
    }
    return {
      accountId: stored.accountId,
      kind: command.kind,
      versionId: stored.versionId,
      version: stored.version,
      consentedAt: stored.consentedAt,
    };
  }
}
