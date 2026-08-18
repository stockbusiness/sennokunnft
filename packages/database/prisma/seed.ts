/* eslint-disable no-restricted-properties */
/**
 * 開発用のシード。
 *
 * ⚠️ **本番では実行しない。** `APP_ENV=production` のとき即座に中止する。
 * 開発中に「空の画面ばかり見て動作確認できない」状態を避けるためのもので、
 * 業務データの投入手段ではない。
 *
 * 冪等にしてあるので、何度実行しても増殖しない。
 */
import { PrismaClient } from '../generated/client';

const APP_ENV = process.env.APP_ENV ?? 'local';
const DATABASE_URL = process.env.DATABASE_URL;

async function main(): Promise<void> {
  if (APP_ENV === 'production') {
    console.error('✗ 本番環境ではシードを実行しません。');
    process.exit(1);
  }
  if (DATABASE_URL === undefined || DATABASE_URL === '') {
    console.error('✗ DATABASE_URL が設定されていません。');
    process.exit(1);
  }

  const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

  try {
    // 運営アカウント。
    // ⚠️ ロールを operator にしているのは開発用だから。
    //    アプリには昇格APIを作っていない（UD-803）。
    const operator = await prisma.account.upsert({
      where: { authProvider_authSubject: { authProvider: 'dev', authSubject: 'seed-operator' } },
      create: {
        authProvider: 'dev',
        authSubject: 'seed-operator',
        displayName: '開発用の運営',
        role: 'operator',
      },
      update: { role: 'operator' },
    });

    const samples = [
      {
        slug: 'sengoku-scroll-01',
        title: '戦国絵巻 其の一',
        description: '千ノ国の物語を描いた作品です。',
        maxSupply: 100,
        priceAmount: 12000,
      },
      {
        slug: 'sengoku-scroll-02',
        title: '戦国絵巻 其の二',
        description: '城下町の賑わいを描いた作品です。',
        maxSupply: 50,
        priceAmount: 18000,
      },
      {
        slug: 'sengoku-draft',
        title: '（下書き）調整中の作品',
        description: '公開前の作品です。カタログには出ません。',
        maxSupply: 10,
        priceAmount: 5000,
      },
    ];

    for (const sample of samples) {
      const isDraft = sample.slug === 'sengoku-draft';

      const artwork = await prisma.artwork.upsert({
        where: { slug: sample.slug },
        create: {
          creatorAccountId: operator.id,
          slug: sample.slug,
          title: sample.title,
          description: sample.description,
          maxSupply: sample.maxSupply,
          // 公開には画像が要る。シードでは検査済みの体で値を入れる。
          imageKey: isDraft ? null : `artworks/seed/${sample.slug}.png`,
          imageContentType: isDraft ? null : 'image/png',
          imageByteSize: isDraft ? null : 2048,
          status: isDraft ? 'draft' : 'published',
        },
        update: {},
      });

      if (isDraft) {
        continue;
      }

      // 有効な出品は作品ごとに 1 件（部分ユニーク索引）。既にあれば作らない。
      const existing = await prisma.listing.findFirst({
        where: { artworkId: artwork.id, status: { in: ['active', 'scheduled'] } },
      });
      if (existing === null) {
        await prisma.listing.create({
          data: {
            artworkId: artwork.id,
            priceAmount: sample.priceAmount,
            priceCurrency: 'JPY',
            status: 'active',
          },
        });
      }
    }

    const artworkCount = await prisma.artwork.count();
    const listingCount = await prisma.listing.count();
    console.log(
      `✓ シードを投入しました（運営 ${operator.displayName ?? operator.id} / 作品 ${String(artworkCount)} 件 / 出品 ${String(listingCount)} 件）`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main();
