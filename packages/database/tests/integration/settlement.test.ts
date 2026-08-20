import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../../generated/client';
import { PrismaSettlementSettingsRepository } from '../../src/repositories/settlement.repository';
import {
  createTestClient,
  integrationTestsAvailable,
  orderSeedFields,
  resetDatabase,
  violatesConstraint,
} from '../helpers/database';

/**
 * 返金と精算の取り決め、および注文の返金期限（`UD-104` / `UD-119`）。
 *
 * ⚠️ ここはドメインの試験ではない。**アプリ側の判定に穴が開いたときに
 * 残る最後の砦**が本当に立っているかを見る。同じ規則の単体試験は
 * `@sengoku/domain` の `settlement.test.ts` が別に持っている。二重に
 * 持つのは重複ではなく、片方が抜けたときにもう片方が気づくための構え。
 */
const enabled = integrationTestsAvailable();
const suite = enabled ? describe : describe.skip;

let prisma: PrismaClient;
let repo: PrismaSettlementSettingsRepository;

/**
 * ⚠️ **`resetDatabase` は `settlement_settings` を消さない。**
 * この表はマイグレーションが入れた取り決めの行で、注文のような
 * 試験データではない。消してしまうと、以降の試験がすべて「未設定」で
 * 走る。書き換える試験のために、行を控えて戻す。
 */
let seeded: {
  refundWindowDays: number;
  payoutOffsetMonths: number;
  minimumPayoutAmount: number;
  transferFeeBearer: string;
} | null = null;

beforeAll(async () => {
  if (!enabled) return;
  prisma = createTestClient();
  await prisma.$connect();
  repo = new PrismaSettlementSettingsRepository(prisma);
  seeded = await prisma.settlementSettings.findUnique({ where: { environment: 'staging' } });
});

afterAll(async () => {
  if (!enabled) return;
  if (seeded !== null) {
    await prisma.settlementSettings.update({ where: { environment: 'staging' }, data: seeded });
  }
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!enabled) return;
  await resetDatabase(prisma);
  if (seeded !== null) {
    await prisma.settlementSettings.update({ where: { environment: 'staging' }, data: seeded });
  }
});

suite('settlement_settings の初期値', () => {
  it('マイグレーションが staging と production の両方へ入れている', async () => {
    /*
      ⚠️ **コードに `?? 14` を書かないための行。** 既定値をコード側に置くと、
         設定行が消えたことに誰も気づかないまま動き続ける。
    */
    const rows = await prisma.settlementSettings.findMany({ orderBy: { environment: 'asc' } });
    expect(rows.map((row) => row.environment)).toEqual(['production', 'staging']);
    for (const row of rows) {
      expect(row.refundWindowDays).toBe(14);
      expect(row.payoutOffsetMonths).toBe(1);
      expect(row.minimumPayoutAmount).toBe(1000);
      expect(row.transferFeeBearer).toBe('creator');
    }
  });

  it('リポジトリが読める（暗号鍵を要らない）', async () => {
    // ⚠️ 取り決めは秘密ではない。復号を通すと、鍵の無い配備で読めなくなる。
    await expect(repo.find('staging')).resolves.toEqual({
      refundWindowDays: 14,
      payoutOffsetMonths: 1,
      minimumPayoutAmount: 1000,
      transferFeeBearer: 'creator',
    });
  });
});

suite('settlement_settings の CHECK 制約', () => {
  it('返金の日数が精算の猶予を超える行を拒む', async () => {
    /*
      ⚠️ **ドメイン側と同じ規則を DB にも置いてある。** アプリを通さずに
         SQL で直した／別の経路が増えたときに、ここが最後に止める。
    */
    await expect(
      prisma.settlementSettings.update({
        where: { environment: 'staging' },
        data: { refundWindowDays: 60, payoutOffsetMonths: 1 },
      }),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'settlement_settings_window_within_payout_delay'),
    );
  });

  it('猶予を伸ばせば同じ日数が通る（規則であって上限ではない）', async () => {
    await expect(
      prisma.settlementSettings.update({
        where: { environment: 'staging' },
        data: { refundWindowDays: 56, payoutOffsetMonths: 2 },
      }),
    ).resolves.toMatchObject({ refundWindowDays: 56 });
  });

  it('返金の日数の上限を超える行を拒む（打ち間違いを止める）', async () => {
    await expect(
      prisma.settlementSettings.update({
        where: { environment: 'staging' },
        data: { refundWindowDays: 3650, payoutOffsetMonths: 6 },
      }),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'settlement_settings_refund_window_range'),
    );
  });

  it('負の最低支払額を拒む', async () => {
    await expect(
      prisma.settlementSettings.update({
        where: { environment: 'staging' },
        data: { minimumPayoutAmount: -1 },
      }),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'settlement_settings_minimum_payout_range'),
    );
  });

  it('知らない負担者を拒む', async () => {
    await expect(
      prisma.settlementSettings.update({
        where: { environment: 'staging' },
        data: { transferFeeBearer: 'buyer' },
      }),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'settlement_settings_fee_bearer_known'),
    );
  });

  it('知らない環境の行を作らせない', async () => {
    await expect(
      prisma.settlementSettings.create({
        data: {
          environment: 'local',
          refundWindowDays: 14,
          payoutOffsetMonths: 1,
          minimumPayoutAmount: 1000,
          transferFeeBearer: 'creator',
        },
      }),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'settlement_settings_environment_known'),
    );
  });

  it('返金を受け付けない設定（0 日）は通る', async () => {
    // ⚠️ 0 は「未設定」ではなく、正しい取り決めのひとつ。
    await expect(
      prisma.settlementSettings.update({
        where: { environment: 'staging' },
        data: { refundWindowDays: 0, payoutOffsetMonths: 0 },
      }),
    ).resolves.toMatchObject({ refundWindowDays: 0 });
  });
});

suite('orders.refundable_until', () => {
  async function seedAccounts(): Promise<{ accountId: string; creatorAccountId: string }> {
    const accountId = randomUUID();
    const creatorAccountId = randomUUID();
    await prisma.account.createMany({
      data: [
        { id: accountId, authProvider: 'fake', authSubject: accountId },
        { id: creatorAccountId, authProvider: 'fake', authSubject: creatorAccountId },
      ],
    });
    return { accountId, creatorAccountId };
  }

  async function createOrder(overrides: Record<string, unknown> = {}): Promise<unknown> {
    const { accountId, creatorAccountId } = await seedAccounts();
    return prisma.order.create({
      data: {
        accountId,
        totalAmount: 3000,
        totalCurrency: 'JPY',
        idempotencyKey: randomUUID(),
        ...orderSeedFields({ creatorAccountId, totalAmount: 3000 }),
        ...overrides,
      },
    });
  }

  it('お支払い前の注文に期限を書けない', async () => {
    /*
      ⚠️ **期限があるのに未払い、という行を残さない。** 残ると、返金の
         判定が「払っていない注文を返金できる」側へ倒れうる。
    */
    await expect(
      createOrder({ paymentStatus: 'pending', refundableUntil: new Date() }),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'orders_refundable_until_requires_payment'),
    );
  });

  it('お支払い済みなら期限を書ける', async () => {
    // ⚠️ `paidAt` も要る（既存の `orders_paid_has_time`）。
    await expect(
      createOrder({ paymentStatus: 'succeeded', paidAt: new Date(), refundableUntil: new Date() }),
    ).resolves.toMatchObject({ paymentStatus: 'succeeded' });
  });

  it('お支払い済みでも期限が空のままでよい（この列より前の注文があるため）', async () => {
    // ⚠️ NOT NULL にしない。移行の途中で既存の行を壊す。
    await expect(
      createOrder({ paymentStatus: 'succeeded', paidAt: new Date(), refundableUntil: null }),
    ).resolves.toMatchObject({ refundableUntil: null });
  });

  it('お支払い前で期限が空なら通る', async () => {
    await expect(createOrder({ paymentStatus: 'pending' })).resolves.toMatchObject({
      refundableUntil: null,
    });
  });
});
