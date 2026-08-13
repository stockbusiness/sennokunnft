import { PrismaClient } from '../../generated/client';

/**
 * 結合テスト用の接続。
 *
 * 実 PostgreSQL に対して動かす。Fake では検証できないもの
 * ——CHECK 制約・UNIQUE 制約・トランザクションの挙動——を確かめるのが目的なので、
 * ここをモックに置き換えるとテストの意味がなくなる。
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/**
 * 結合テストを実行できるか。
 *
 * ⚠️ **黙ってスキップさせない。**
 * `REQUIRE_INTEGRATION_TESTS=1` が立っているとき（CI）に接続先が無ければ、
 * スキップではなく失敗させる。設定漏れで検査が素通りすると、
 * 「制約は効いているはず」という誤った安心を生む。
 */
export function integrationTestsAvailable(): boolean {
  const required = process.env.REQUIRE_INTEGRATION_TESTS === '1';
  if (TEST_DATABASE_URL === undefined || TEST_DATABASE_URL === '') {
    if (required) {
      throw new Error(
        'REQUIRE_INTEGRATION_TESTS=1 ですが TEST_DATABASE_URL が設定されていません。結合テストを黙って飛ばさないため、失敗させます。',
      );
    }
    return false;
  }
  return true;
}

export function createTestClient(): PrismaClient {
  if (TEST_DATABASE_URL === undefined) {
    throw new Error('TEST_DATABASE_URL is not set');
  }
  return new PrismaClient({
    datasources: { db: { url: TEST_DATABASE_URL } },
    log: ['warn', 'error'],
  });
}

/** テーブルを空にする。外部キーの依存順に削除する。 */
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      nft_tokens, mint_jobs, entitlements, order_lines, payments, orders,
      listings, artworks, accounts, webhook_events, outbox_events, audit_logs
    RESTART IDENTITY CASCADE
  `);
}

/** PostgreSQL のエラーコードを取り出す（制約違反の種別を確かめるため）。 */
export function pgErrorCode(error: unknown): string | undefined {
  const candidate = error as { code?: unknown; meta?: { code?: unknown } };
  if (typeof candidate.code === 'string') {
    return candidate.code;
  }
  if (typeof candidate.meta?.code === 'string') {
    return candidate.meta.code;
  }
  return undefined;
}

/** 例外メッセージに制約名が含まれているか。 */
export function violatesConstraint(error: unknown, constraintName: string): boolean {
  return error instanceof Error && error.message.includes(constraintName);
}
