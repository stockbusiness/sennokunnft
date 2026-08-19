import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../../generated/client';
import {
  PrismaLegalConsentRepository,
  PrismaLegalDocumentRepository,
} from '../../src/repositories/legal.repository';
import {
  createTestClient,
  integrationTestsAvailable,
  resetDatabase,
  violatesConstraint,
} from '../helpers/database';

/**
 * 法務文書の版を、実 PostgreSQL に対して確かめる。
 *
 * ⚠️ **ここを Fake で済ませない。** 確かめたいのは
 * 「下書きが 2 つにならない」「揃っていない公開済みが作れない」で、
 * どちらも部分UNIQUE と CHECK が保証している。Fake は制約を持たないので、
 * 制約を外しても試験が通ってしまう。実際に、決済の設定を足したときに
 * `service` の CHECK を 1 つ書き忘れ、Fake の試験は全部通ったまま
 * 本物だけが落ちた。
 */
const enabled = integrationTestsAvailable();
const suite = enabled ? describe : describe.skip;

let prisma: PrismaClient;
let repo: PrismaLegalDocumentRepository;
let accountId: string;

const NOW = new Date('2026-08-19T12:00:00.000Z');
const LATER = new Date('2026-09-01T00:00:00.000Z');

async function seedAccount(): Promise<string> {
  const id = randomUUID();
  await prisma.account.create({
    data: { id, authProvider: 'dev', authSubject: `legal-${id}`, role: 'operator' },
  });
  return id;
}

beforeAll(() => {
  if (!enabled) {
    return;
  }
  prisma = createTestClient();
  repo = new PrismaLegalDocumentRepository(prisma);
});

afterAll(async () => {
  if (enabled) {
    await prisma.$disconnect();
  }
});

beforeEach(async () => {
  if (!enabled) {
    return;
  }
  await resetDatabase(prisma);
  accountId = await seedAccount();
});

suite('法務文書の版', () => {
  it('種類ごとに連番が進む（表全体の通し番号にしない）', async () => {
    const terms = await repo.create({
      kind: 'terms',
      title: '利用規約',
      bodyText: '本文',
      tokushoho: null,
      createdByAccountId: accountId,
    });
    expect(terms.version).toBe(1);

    await repo.publish({
      id: terms.id,
      effectiveFrom: LATER,
      publishedByAccountId: accountId,
      publishedAt: NOW,
      requiresReconsent: false,
    });

    const privacy = await repo.create({
      kind: 'privacy',
      title: 'プライバシーポリシー',
      bodyText: '本文',
      tokushoho: null,
      createdByAccountId: accountId,
    });
    // ⚠️ 種類が違えば 1 から始まる。「規約 第3版」と言えるように。
    expect(privacy.version).toBe(1);

    const terms2 = await repo.create({
      kind: 'terms',
      title: '利用規約',
      bodyText: '直した本文',
      tokushoho: null,
      createdByAccountId: accountId,
    });
    expect(terms2.version).toBe(2);
  });

  it('下書きは種類ごとに 1 つしか作れない（部分UNIQUE）', async () => {
    await repo.create({
      kind: 'terms',
      title: '利用規約',
      bodyText: '本文',
      tokushoho: null,
      createdByAccountId: accountId,
    });

    await expect(
      repo.create({
        kind: 'terms',
        title: 'もうひとつの下書き',
        bodyText: '本文',
        tokushoho: null,
        createdByAccountId: accountId,
      }),
    ).rejects.toThrow();
  });

  it('公開済みの行は下書きの口から書き換えられない', async () => {
    const draft = await repo.create({
      kind: 'terms',
      title: '利用規約',
      bodyText: '最初の本文',
      tokushoho: null,
      createdByAccountId: accountId,
    });
    await repo.publish({
      id: draft.id,
      effectiveFrom: LATER,
      publishedByAccountId: accountId,
      publishedAt: NOW,
      requiresReconsent: false,
    });

    /*
      ⚠️ ここが `null` を返すことが要。返さずに書き換わると、
         「その注文の時点でどう書いてあったか」が失われる。
    */
    const result = await repo.saveDraft({
      id: draft.id,
      title: '書き換え',
      bodyText: 'あとから直した本文',
      tokushoho: null,
    });
    expect(result).toBeNull();

    const stored = await repo.findById(draft.id);
    expect(stored?.bodyText).toBe('最初の本文');
  });

  it('二重に公開できない', async () => {
    const draft = await repo.create({
      kind: 'terms',
      title: '利用規約',
      bodyText: '本文',
      tokushoho: null,
      createdByAccountId: accountId,
    });
    await repo.publish({
      id: draft.id,
      effectiveFrom: LATER,
      publishedByAccountId: accountId,
      publishedAt: NOW,
      requiresReconsent: false,
    });

    const second = await repo.publish({
      id: draft.id,
      effectiveFrom: new Date('2026-10-01T00:00:00.000Z'),
      publishedByAccountId: accountId,
      publishedAt: NOW,
      requiresReconsent: false,
    });
    expect(second).toBeNull();
  });

  it('施行日を揃えた公開済みを 2 つ作れない', async () => {
    const first = await repo.create({
      kind: 'terms',
      title: '利用規約',
      bodyText: '本文',
      tokushoho: null,
      createdByAccountId: accountId,
    });
    await repo.publish({
      id: first.id,
      effectiveFrom: LATER,
      publishedByAccountId: accountId,
      publishedAt: NOW,
      requiresReconsent: false,
    });

    const second = await repo.create({
      kind: 'terms',
      title: '利用規約',
      bodyText: '別の本文',
      tokushoho: null,
      createdByAccountId: accountId,
    });
    await expect(
      repo.publish({
        id: second.id,
        effectiveFrom: LATER,
        publishedByAccountId: accountId,
        publishedAt: NOW,
        requiresReconsent: false,
      }),
    ).rejects.toThrow();
  });
});

suite('DB の縛り', () => {
  it('知らない種類は入らない', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "legal_document_versions"
           ("kind", "version", "title", "created_by_account_id", "updated_at")
         VALUES ('unknown', 1, '表題', $1::uuid, CURRENT_TIMESTAMP)`,
        accountId,
      ),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'legal_document_versions_kind_valid'),
    );
  });

  /*
    ⚠️ **施行日の無い「公開済み」を作らせない。** あると、施行中の版を
       選ぶ問い合わせがそれを飛ばして古い版を出す。画面には「公開済み」と
       出ているのに、利用者には古い文が見える、という気づきにくい形になる。
  */
  it('施行日の無い公開済みは入らない', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "legal_document_versions"
           ("kind", "version", "status", "title", "created_by_account_id", "updated_at")
         VALUES ('terms', 1, 'published', '表題', $1::uuid, CURRENT_TIMESTAMP)`,
        accountId,
      ),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'legal_document_versions_published_complete'),
    );
  });

  it('特商法の行に本文は入らない（どちらが表示されるか実装依存になる）', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "legal_document_versions"
           ("kind", "version", "title", "body_text", "created_by_account_id", "updated_at")
         VALUES ('tokushoho', 1, '表記', '本文', $1::uuid, CURRENT_TIMESTAMP)`,
        accountId,
      ),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'legal_document_versions_body_shape'),
    );
  });

  it('同じ種類で同じ版番号は入らない', async () => {
    await repo.create({
      kind: 'terms',
      title: '利用規約',
      bodyText: '本文',
      tokushoho: null,
      createdByAccountId: accountId,
    });
    // 公開済みとして正しく揃えたうえで、版番号だけをぶつける。
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "legal_document_versions"
           ("kind", "version", "status", "title", "body_text", "effective_from",
            "published_at", "published_by_account_id", "created_by_account_id", "updated_at")
         VALUES ('terms', 1, 'published', '表題', '本文', CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP, $1::uuid, $1::uuid, CURRENT_TIMESTAMP)`,
        accountId,
      ),
    ).rejects.toSatisfy((error: unknown) => violatesConstraint(error, '(kind, version)'));
  });
});

suite('規約への同意（`UD-126`）', () => {
  async function publishTerms(
    version: number,
    options: { readonly requiresReconsent?: boolean } = {},
  ): Promise<string> {
    const draft = await repo.create({
      kind: 'terms',
      title: '利用規約',
      bodyText: `第${String(version)}版`,
      tokushoho: null,
      createdByAccountId: accountId,
    });
    const published = await repo.publish({
      id: draft.id,
      // 版ごとに施行日をずらす（同じ瞬間に 2 つ施行させない）。
      effectiveFrom: new Date(NOW.getTime() + version * 1000),
      publishedByAccountId: accountId,
      publishedAt: NOW,
      requiresReconsent: options.requiresReconsent ?? false,
    });
    if (published === null) {
      throw new Error('publish failed');
    }
    return published.id;
  }

  it('二度押しても行が増えない', async () => {
    const consents = new PrismaLegalConsentRepository(prisma);
    const versionId = await publishTerms(1);

    for (const _ of [1, 2, 3]) {
      await consents.recordConsent({
        accountId,
        kind: 'terms',
        versionId,
        version: 1,
        consentedAt: NOW,
      });
    }

    const count = await prisma.legalConsent.count({ where: { accountId } });
    expect(count).toBe(1);
  });

  it('最初に同意した日時を上書きしない', async () => {
    const consents = new PrismaLegalConsentRepository(prisma);
    const versionId = await publishTerms(1);
    await consents.recordConsent({
      accountId,
      kind: 'terms',
      versionId,
      version: 1,
      consentedAt: NOW,
    });
    const later = new Date(NOW.getTime() + 3_600_000);
    const second = await consents.recordConsent({
      accountId,
      kind: 'terms',
      versionId,
      version: 1,
      consentedAt: later,
    });
    // ⚠️ 上書きすると「いつ同意したのか」が動く。
    expect(second.consentedAt.getTime()).toBe(NOW.getTime());
  });

  /*
    ⚠️ **利用規約以外の同意を作らせない。** 作れると、「プライバシー
       ポリシーにも同意を取ってある」と読める記録が残り、実際には
       取っていない同意を取ったことにできる。
  */
  it('利用規約以外の種類では同意を記録できない', async () => {
    const draft = await repo.create({
      kind: 'privacy',
      title: 'プライバシーポリシー',
      bodyText: '本文',
      tokushoho: null,
      createdByAccountId: accountId,
    });
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "legal_consents" ("account_id", "kind", "version_id", "version")
         VALUES ($1::uuid, 'privacy', $2::uuid, 1)`,
        accountId,
        draft.id,
      ),
    ).rejects.toSatisfy((error: unknown) => violatesConstraint(error, 'legal_consents_kind_valid'));
  });

  it('再同意の印は、印が立った版より前に同意した人にだけ効く', async () => {
    const consents = new PrismaLegalConsentRepository(prisma);
    const first = await publishTerms(1);
    await consents.recordConsent({
      accountId,
      kind: 'terms',
      versionId: first,
      version: 1,
      consentedAt: NOW,
    });

    // 誤字の修正（印を立てない）。
    await publishTerms(2);
    const afterMinor = new Date(NOW.getTime() + 10_000);
    expect(await consents.hasPendingReconsent('terms', 1, afterMinor)).toBe(false);

    // 実質的な変更（印を立てる）。
    await publishTerms(3, { requiresReconsent: true });
    const afterMajor = new Date(NOW.getTime() + 10_000);
    expect(await consents.hasPendingReconsent('terms', 1, afterMajor)).toBe(true);
    // すでに第3版へ同意している人には効かない。
    expect(await consents.hasPendingReconsent('terms', 3, afterMajor)).toBe(false);
  });

  /*
    ⚠️ **施行日が来ていない版で先に止めない。** 予約公開した改定の
       同意を、施行前から求めてしまうと、まだ効いていない条件に
       同意させることになる。
  */
  it('施行日が来ていない版の印では止めない', async () => {
    const consents = new PrismaLegalConsentRepository(prisma);
    await publishTerms(1);
    await publishTerms(2, { requiresReconsent: true });
    // 第2版の施行日（NOW + 2 秒）より前の時刻で確かめる。
    const beforeEffective = new Date(NOW.getTime() + 1_500);
    expect(await consents.hasPendingReconsent('terms', 1, beforeEffective)).toBe(false);
  });

  it('下書きに再同意の印は立たない', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "legal_document_versions"
           ("kind", "version", "status", "title", "body_text", "requires_reconsent",
            "created_by_account_id", "updated_at")
         VALUES ('terms', 99, 'draft', '表題', '本文', true, $1::uuid, CURRENT_TIMESTAMP)`,
        accountId,
      ),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'legal_document_versions_reconsent_published_only'),
    );
  });
});
