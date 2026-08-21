import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../../generated/client';
import { PrismaCreatorProfileDetailRepository } from '../../src/repositories/creator.repository';
import {
  createTestClient,
  integrationTestsAvailable,
  resetDatabase,
  violatesConstraint,
} from '../helpers/database';

/**
 * 作家さまのプロフィール（実運営 指示書 P1-2）。
 *
 * ⚠️ ここで見たいのは 3 つ。
 *  1. **表示名に触れないこと。** 一緒に書くと、他人と被っているときに
 *     紹介文まで保存できなくなる
 *  2. **画像の鍵が、紹介文の保存で消えないこと**
 *  3. **形の違うインボイス番号を保存できないこと**
 */
const enabled = integrationTestsAvailable();
const suite = enabled ? describe : describe.skip;

const NOW = new Date('2026-08-21T00:00:00.000Z');

let prisma: PrismaClient;
let profiles: PrismaCreatorProfileDetailRepository;
let accountId: string;

beforeAll(() => {
  if (!enabled) return;
  prisma = createTestClient();
  profiles = new PrismaCreatorProfileDetailRepository(prisma);
});

afterAll(async () => {
  if (enabled) await prisma.$disconnect();
});

beforeEach(async () => {
  if (!enabled) return;
  await resetDatabase(prisma);
  accountId = randomUUID();
  await prisma.account.create({
    data: {
      id: accountId,
      authProvider: 'dev',
      authSubject: `creator-${accountId}`,
      displayName: '桜',
      displayNameKey: 'さくら',
    },
  });
});

const EMPTY = { shopName: null, bio: null, links: [], invoiceNumber: null };

suite('保存と読み取り', () => {
  it('未登録なら null', async () => {
    expect(await profiles.find(accountId)).toBeNull();
  });

  it('保存して読み戻せる', async () => {
    await profiles.save({
      accountId,
      shopName: '桜屋',
      bio: '日本画を描いています。',
      links: [{ label: 'ホームページ', url: 'https://example.test' }],
      invoiceNumber: 'T1234567890123',
      now: NOW,
    });

    const found = await profiles.find(accountId);
    expect(found?.shopName).toBe('桜屋');
    expect(found?.links).toEqual([{ label: 'ホームページ', url: 'https://example.test' }]);
    expect(found?.invoiceNumber).toBe('T1234567890123');
  });

  it('二度目は上書きになる（行が増えない）', async () => {
    await profiles.save({ ...EMPTY, accountId, shopName: '一度目', now: NOW });
    await profiles.save({ ...EMPTY, accountId, shopName: '二度目', now: NOW });

    expect(await prisma.creatorProfile.count({ where: { accountId } })).toBe(1);
    expect((await profiles.find(accountId))?.shopName).toBe('二度目');
  });

  /*
    ⚠️ **表示名に触れない。** 一緒に書くと、他人と被っているときに
       紹介文まで保存できなくなる。
  */
  it('表示名を書き換えない', async () => {
    await profiles.save({ ...EMPTY, accountId, bio: '紹介文', now: NOW });
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.displayName).toBe('桜');
  });
});

suite('画像の鍵', () => {
  /*
    ⚠️ **紹介文の保存で画像が消えない。** 消えると、直すたびに
       貼り直すことになる。
  */
  it('紹介文を保存し直しても画像は残る', async () => {
    await profiles.saveImageKey({ accountId, slot: 'icon', key: 'images/icon.png', now: NOW });
    await profiles.save({ ...EMPTY, accountId, bio: 'あとから書いた紹介文', now: NOW });

    const found = await profiles.find(accountId);
    expect(found?.iconKey).toBe('images/icon.png');
    expect(found?.bio).toBe('あとから書いた紹介文');
  });

  it('アイコンとカバーは別々に持つ', async () => {
    await profiles.saveImageKey({ accountId, slot: 'icon', key: 'images/icon.png', now: NOW });
    await profiles.saveImageKey({ accountId, slot: 'cover', key: 'images/cover.png', now: NOW });

    const found = await profiles.find(accountId);
    expect(found?.iconKey).toBe('images/icon.png');
    expect(found?.coverKey).toBe('images/cover.png');
  });

  it('プロフィールが無くても画像だけ先に置ける', async () => {
    await profiles.saveImageKey({ accountId, slot: 'cover', key: 'images/cover.png', now: NOW });
    expect((await profiles.find(accountId))?.coverKey).toBe('images/cover.png');
  });
});

suite('DB の縛り', () => {
  /*
    ⚠️ **取り違えた値をそのまま保存させない。** 実在の確認ではない。
  */
  it('形の違うインボイス番号は拒む', async () => {
    await expect(
      prisma.creatorProfile.create({
        data: { accountId, invoiceNumber: '1234567890123', createdAt: NOW, updatedAt: NOW },
      }),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'creator_profiles_invoice_number_format'),
    );
  });

  /*
    ⚠️ **空文字と NULL を混ぜない。** 混ざると、画面の出し分けが 2 通りになる。
  */
  it('空文字は拒む（未設定は NULL で表す）', async () => {
    await expect(
      prisma.creatorProfile.create({
        data: { accountId, shopName: '   ', createdAt: NOW, updatedAt: NOW },
      }),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'creator_profiles_no_blank_strings'),
    );
  });

  it('リンクが配列でなければ拒む', async () => {
    await expect(
      prisma.creatorProfile.create({
        data: { accountId, links: { label: 'X' }, createdAt: NOW, updatedAt: NOW },
      }),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'creator_profiles_links_is_array'),
    );
  });

  it('リンクが多すぎれば拒む', async () => {
    const links = Array.from({ length: 6 }, (_, i) => ({
      label: `l${String(i)}`,
      url: 'https://example.test',
    }));
    await expect(
      prisma.creatorProfile.create({ data: { accountId, links, createdAt: NOW, updatedAt: NOW } }),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'creator_profiles_links_count'),
    );
  });

  it('長すぎる紹介文は拒む', async () => {
    await expect(
      prisma.creatorProfile.create({
        data: { accountId, bio: 'あ'.repeat(2001), createdAt: NOW, updatedAt: NOW },
      }),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'creator_profiles_bio_length'),
    );
  });
});

suite('販売規約', () => {
  /*
    ⚠️ **同意の仕組みを作り直さない。** 版管理・施行日・再同意の判定は
       すでにある（`UD-126`）。相乗りできることを確かめる。
  */
  it('法務文書の種別として保存できる', async () => {
    const version = await prisma.legalDocumentVersion.create({
      data: {
        kind: 'creator_terms',
        version: 1,
        status: 'published',
        title: '販売規約',
        bodyText: '本文',
        effectiveFrom: NOW,
        publishedAt: NOW,
        createdByAccountId: accountId,
        publishedByAccountId: accountId,
      },
    });
    expect(version.kind).toBe('creator_terms');
  });

  it('同意も記録できる', async () => {
    const version = await prisma.legalDocumentVersion.create({
      data: {
        kind: 'creator_terms',
        version: 1,
        status: 'published',
        title: '販売規約',
        bodyText: '本文',
        effectiveFrom: NOW,
        publishedAt: NOW,
        createdByAccountId: accountId,
        publishedByAccountId: accountId,
      },
    });
    const consent = await prisma.legalConsent.create({
      data: {
        accountId,
        kind: 'creator_terms',
        versionId: version.id,
        version: 1,
        consentedAt: NOW,
      },
    });
    expect(consent.kind).toBe('creator_terms');
  });

  it('知らない種別は DB が拒む', async () => {
    await expect(
      prisma.legalDocumentVersion.create({
        data: {
          kind: 'whatever_terms',
          version: 1,
          status: 'draft',
          title: 'なにか',
          createdByAccountId: accountId,
        },
      }),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'legal_document_versions_kind_valid'),
    );
  });
});
