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

/**
 * テーブルを空にする。外部キーの依存順に削除する。
 *
 * ⚠️ **`CASCADE` は名前を書いていない表まで空にする。**
 * `settlement_settings` は `accounts` を参照しているので、`accounts` を
 * 切ると一緒に消える。ここは試験データではなく**取り決め**の表で、
 * 初期値はマイグレーションが一度だけ入れる決まりになっている
 * （`docs/SETTLEMENT_AND_REFUND.md` §1）。消えたまま次の試験が走ると、
 * すべての試験が「返金の取り決めが未登録」の配備を相手にすることになり、
 * **本番と違う前提で緑になる**。切ったあとに必ず戻す。
 */
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  const settlement = await prisma.settlementSettings.findMany();
  /*
    ⚠️ **知らせの文面は「基準データ」で、試験ごとの汚れではない。**
       `accounts` の TRUNCATE が CASCADE で連れていくので、退避して戻す。
       戻さないと、文面が無いために知らせが 1 通も積まれず、
       通知まわりの試験がすべて**空振りしたまま緑になる**。
  */
  /*
    ⚠️ **文面は消さない。** 版 1 はマイグレーションが入れる「基準の文面」で、
       試験ごとの汚れではない。消してしまうと、文面が無いために知らせが
       1 通も積まれず、通知まわりの試験が**空振りしたまま緑になる**。
       試験が作った版（2 以降）だけを片づける。
    ⚠️ `notification_templates` は `accounts` への外部キーを持たないので、
       下の TRUNCATE ... CASCADE では消えない。
  */
  await prisma.notificationTemplate.deleteMany({ where: { version: { gt: 1 } } });
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      nft_tokens, mint_jobs, entitlements, inventory_reservations, order_lines, payout_lines, payouts, refunds, payments,
      orders, wallet_delivery_outbox, listings, artworks, idempotency_keys, hmac_nonces, accounts,
      webhook_events, outbox_events, audit_logs, legal_consents, legal_document_versions,
      payment_credentials, settlement_settings,
      notification_deliveries,
      account_notes, email_change_requests,
      /*
        ⚠️ **時計仕掛けの記録も消す。** 残すと、次の試験が
           「一度も動いていない」を作れなくなる——止まった時計に
           気づけるかどうかを確かめる試験が、そこで空振りする。
      */
      job_runs,
      -- ⚠️ TRUNCATE は行トリガーを撃たない。証跡は追記のみで DELETE は
      --    トリガーが拒むが、TRUNCATE は素通りする。試験を片づけられるのは
      --    そのおかげ。**本番でこれを実行しない。**
      production_attestations
    RESTART IDENTITY CASCADE
  `);

  /*
    ⚠️ **変更者（`updated_by_account_id`）は復元しない。** アカウントごと
       消えているので、参照が宙に浮く。取り決めの中身だけを戻す。
  */
  const rows = settlement.length > 0 ? settlement : SEEDED_SETTLEMENT_SETTINGS;
  await prisma.settlementSettings.createMany({
    data: rows.map((row) => ({
      environment: row.environment,
      refundWindowDays: row.refundWindowDays,
      payoutOffsetMonths: row.payoutOffsetMonths,
      minimumPayoutAmount: row.minimumPayoutAmount,
      transferFeeBearer: row.transferFeeBearer,
    })),
  });
}

/**
 * 取り決めが失われていたときに戻す値。
 *
 * ⚠️ **これは既定値の定義ではない。** 正はマイグレーション
 * （`20260820100000_settlement_settings`）で、ここはその**写し**。
 * 写しを置いているのは、前の実行が途中で落ちて表が空のまま残ったときに、
 * 以降の試験がすべて「未設定の配備」を相手に緑になるのを避けるため。
 *
 * ⚠️ **写しがずれたら試験が落ちる。** `settlement.test.ts` の
 * 「マイグレーションが staging と production の両方へ入れている」が、
 * マイグレーションの入れた値を直接見ている。
 */
const SEEDED_SETTLEMENT_SETTINGS = [
  {
    environment: 'staging',
    refundWindowDays: 14,
    payoutOffsetMonths: 1,
    minimumPayoutAmount: 1000,
    transferFeeBearer: 'creator',
  },
  {
    environment: 'production',
    refundWindowDays: 14,
    payoutOffsetMonths: 1,
    minimumPayoutAmount: 1000,
    transferFeeBearer: 'creator',
  },
] as const;

/**
 * PostgreSQL のエラーコードを取り出す（制約違反の種別を確かめるため）。
 *
 * ⚠️ **`meta.code` を先に見る。** `$executeRaw` が落ちたとき、Prisma は外側の
 * `code` を自前の `P2010`（raw query failed）にし、PostgreSQL の本当のコード
 * （`23505` など）を `meta.code` へ入れる。外側を先に読むと、生の SQL で
 * 起こした一意制約違反が**ただの実行時エラーに見えてしまう**。
 */
export function pgErrorCode(error: unknown): string | undefined {
  const candidate = error as { code?: unknown; meta?: { code?: unknown } };
  if (typeof candidate.meta?.code === 'string') {
    return candidate.meta.code;
  }
  if (typeof candidate.code === 'string') {
    return candidate.code;
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
