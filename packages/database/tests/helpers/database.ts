import { randomUUID } from 'node:crypto';
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
 * 接続先が無いときにスキップで済ませると、検査が素通りしたことに気づけず、
 * 「制約は効いているはず」という誤った安心を生む。
 *
 * ⚠️ **判定を `REQUIRE_INTEGRATION_TESTS` だけに委ねない。**
 * この変数自体が実行環境に届かないことがある——実際に Turborepo 2 の
 * 環境変数の絞り込みで届かず、「必須にしたつもりの検査」が CI で
 * 丸ごと飛んでいた。合図が届かなければ、合図を頼りにした番人は何もしない。
 * そこで `CI` でも要求されているものとして扱い、片方が欠けても止まるようにする。
 */
export function integrationTestsAvailable(): boolean {
  const required = process.env.REQUIRE_INTEGRATION_TESTS === '1' || process.env.CI === 'true';
  if (TEST_DATABASE_URL === undefined || TEST_DATABASE_URL === '') {
    if (required) {
      throw new Error(
        '結合テストが必須の環境（REQUIRE_INTEGRATION_TESTS=1 または CI）ですが TEST_DATABASE_URL が設定されていません。黙って飛ばさないため、失敗させます。',
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
      nft_tokens, mint_jobs, entitlements, inventory_reservations, order_lines, payments, orders,
      wallet_delivery_outbox, listings, artworks, idempotency_keys, hmac_nonces, accounts,
      webhook_events, outbox_events, audit_logs, legal_document_versions
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

/**
 * 一意制約違反かどうか。
 *
 * ⚠️ Prisma は一意制約違反を独自のメッセージ（P2002）に変換するため、
 * CHECK 制約のように制約名で判定できない。
 * 制約名を確かめたい場合は `$queryRawUnsafe` で生の SQL を使う。
 */
export function violatesUniqueConstraint(error: unknown): boolean {
  const code = pgErrorCode(error);
  if (code === 'P2002' || code === '23505') {
    return true;
  }
  return (
    error instanceof Error && /Unique constraint failed|duplicate key value/i.test(error.message)
  );
}

/**
 * 注文の下地を作るときの、この試験では関心の無い列。
 *
 * 決済 Phase P0 で `orders` に必須の列が増えた（注文番号・出品者・
 * 内訳の金額）。各テストがそれぞれ埋めると、値の意味が場所ごとにずれる。
 *
 * ⚠️ 手数料は 0 のまま。率は事業判断待ち（UD-109）で、
 * ここに仮の率を置くと「決まった値」に見えてしまう。
 */
export function orderSeedFields(input: {
  readonly creatorAccountId: string;
  readonly totalAmount: number;
}): {
  readonly orderNumber: string;
  readonly creatorAccountId: string;
  readonly subtotalAmount: number;
  readonly discountAmount: number;
  readonly platformFeeRateBps: number;
  readonly platformFeeAmount: number;
  readonly creatorAmount: number;
} {
  return {
    orderNumber: `TEST-${randomUUID()}`,
    creatorAccountId: input.creatorAccountId,
    subtotalAmount: input.totalAmount,
    discountAmount: 0,
    platformFeeRateBps: 0,
    platformFeeAmount: 0,
    creatorAmount: input.totalAmount,
  };
}

/** 注文明細の下地。単価 × 数量を CHECK 制約が見るため、合計をここで揃える。 */
export function orderLineSeedFields(input: {
  readonly creatorAccountId: string;
  readonly unitPriceAmount: number;
  readonly quantity: number;
}): {
  readonly creatorAccountId: string;
  readonly totalAmount: number;
} {
  return {
    creatorAccountId: input.creatorAccountId,
    totalAmount: input.unitPriceAmount * input.quantity,
  };
}
