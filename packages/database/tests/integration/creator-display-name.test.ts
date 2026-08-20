import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { displayNameKey, validateDisplayName } from '@sengoku/domain';
import type { PrismaClient } from '../../generated/client';
import { PrismaCreatorProfileRepository } from '../../src/repositories/profile.repository';
import {
  createTestClient,
  integrationTestsAvailable,
  orderLineSeedFields,
  orderSeedFields,
  resetDatabase,
  violatesConstraint,
  violatesUniqueConstraint,
} from '../helpers/database';

/**
 * 作家さまの表示名（決定 2026-08-20「屋号・ペンネームを許す／重複を許さない」）。
 *
 * ⚠️ ここはドメインの試験ではない。**アプリ側の判定に穴が開いたときに残る
 * 最後の砦**が本当に立っているかを見る。同じ規則の単体試験は
 * `@sengoku/domain` の `display-name.test.ts` が別に持っている。二重に持つのは
 * 重複ではなく、片方が抜けたときにもう片方が気づくための構え。
 *
 * ⚠️ **重複判定の鍵をアプリ側で作っている以上、ここは「鍵が同じなら DB が
 * 止める」ことしか見られない。** 「同じ見た目なら同じ鍵になる」の担保は
 * ドメイン側の試験にある。両方が揃って初めてなりすましを止められる。
 */
const enabled = integrationTestsAvailable();
const suite = enabled ? describe : describe.skip;

let prisma: PrismaClient;
let repo: PrismaCreatorProfileRepository;

beforeAll(async () => {
  if (!enabled) return;
  prisma = createTestClient();
  await prisma.$connect();
  repo = new PrismaCreatorProfileRepository(prisma);
});

afterAll(async () => {
  if (!enabled) return;
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!enabled) return;
  await resetDatabase(prisma);
});

async function seedAccount(): Promise<string> {
  const id = randomUUID();
  await prisma.account.create({ data: { id, authProvider: 'fake', authSubject: id } });
  return id;
}

/** ドメインの検証を通した値。⚠️ 生の文字列から鍵を作り直さない。 */
function validated(name: string): { value: string; key: string } {
  const result = validateDisplayName(name);
  if (!result.ok) {
    throw new Error(`テストの前提が壊れている: ${name} は検証を通らない`);
  }
  return result.value;
}

suite('表示名の重複（accounts_display_name_key_unique）', () => {
  it('同じ鍵の表示名を 2 人が持てない', async () => {
    const first = await seedAccount();
    const second = await seedAccount();

    expect((await repo.saveDisplayName(first, validated('戦国工房'))).ok).toBe(true);

    const taken = await repo.saveDisplayName(second, validated('戦国工房'));
    expect(taken.ok).toBe(false);
    if (!taken.ok) {
      // ⚠️ 例外のまま外へ出さない。500 は「こちらの不具合」に見える。
      expect(taken.error.code).toBe('DISPLAY_NAME_TAKEN');
    }
  });

  it.each([
    ['全角と半角', 'Ａ工房', 'A工房'],
    ['大文字と小文字', 'Taro Studio', 'taro studio'],
    ['空白の有無', '戦国 太郎', '戦国太郎'],
  ])('%s の違いだけでは、DB もすり抜けさせない', async (_label, first, second) => {
    /*
      ⚠️ **ここが抜けると重複を禁じた意味が無い。** 買う人にはどれも同じに
         見える。実質のなりすましになる。
    */
    const a = await seedAccount();
    const b = await seedAccount();
    expect((await repo.saveDisplayName(a, validated(first))).ok).toBe(true);
    expect((await repo.saveDisplayName(b, validated(second))).ok).toBe(false);
  });

  it('別の名前は通る（そろえすぎて別人を弾かない）', async () => {
    // ⚠️ 弾かれた側は自分では直せない。カタカナとひらがなはまとめない。
    const a = await seedAccount();
    const b = await seedAccount();
    expect((await repo.saveDisplayName(a, validated('サクラ'))).ok).toBe(true);
    expect((await repo.saveDisplayName(b, validated('さくら'))).ok).toBe(true);
  });

  it('自分の名前を同じ値で書き直せる（自分自身とは衝突しない）', async () => {
    const id = await seedAccount();
    expect((await repo.saveDisplayName(id, validated('あかつき絵巻'))).ok).toBe(true);
    expect((await repo.saveDisplayName(id, validated('あかつき絵巻'))).ok).toBe(true);
  });

  it('やめた人の名前は、書き換えれば次の人が使える', async () => {
    const a = await seedAccount();
    const b = await seedAccount();
    await repo.saveDisplayName(a, validated('宵の口'));
    await repo.saveDisplayName(a, validated('宵の口あらため'));
    expect((await repo.saveDisplayName(b, validated('宵の口'))).ok).toBe(true);
  });

  it('鍵の索引は部分索引（表示名の無いアカウントは何人でも並べる）', async () => {
    /*
      ⚠️ **買う人のほとんどは表示名を持たない。** NULL が 1 件しか入らない
         索引にすると、2 人目の会員登録が落ちる。
    */
    await seedAccount();
    await seedAccount();
    const rows = await prisma.account.findMany({ where: { displayNameKey: null } });
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it('SQL で直に入れても止まる（アプリを通らない経路でも守る）', async () => {
    const a = await seedAccount();
    const b = await seedAccount();
    const key = displayNameKey('直書き工房');
    await prisma.$executeRaw`
      UPDATE "accounts" SET "display_name" = '直書き工房', "display_name_key" = ${key}
      WHERE "id" = ${a}::uuid`;

    const attempt = prisma.$executeRaw`
      UPDATE "accounts" SET "display_name" = '直書き工房', "display_name_key" = ${key}
      WHERE "id" = ${b}::uuid`;
    await expect(attempt).rejects.toSatisfy(violatesUniqueConstraint);
  });
});

suite('表示名と鍵は対で入る（accounts_display_name_paired）', () => {
  it('表示名だけを入れられない（重複判定をすり抜ける行になる）', async () => {
    const id = await seedAccount();
    const attempt = prisma.$executeRaw`
      UPDATE "accounts" SET "display_name" = '片側だけ' WHERE "id" = ${id}::uuid`;
    await expect(attempt).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'accounts_display_name_paired'),
    );
  });

  it('鍵だけを入れられない（表示できない行になる）', async () => {
    const id = await seedAccount();
    const attempt = prisma.$executeRaw`
      UPDATE "accounts" SET "display_name_key" = 'かたがわだけ' WHERE "id" = ${id}::uuid`;
    await expect(attempt).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'accounts_display_name_paired'),
    );
  });

  it('両方を消すのは通る（名乗るのをやめられる）', async () => {
    const id = await seedAccount();
    await repo.saveDisplayName(id, validated('やめる工房'));
    await prisma.$executeRaw`
      UPDATE "accounts" SET "display_name" = NULL, "display_name_key" = NULL WHERE "id" = ${id}::uuid`;
    const row = await prisma.account.findUnique({ where: { id } });
    expect(row?.displayName).toBeNull();
  });
});

suite('注文へのスナップショット（order_lines.creator_name_snapshot）', () => {
  async function seedOrderLine(creatorNameSnapshot: string | null): Promise<string> {
    const buyerId = await seedAccount();
    const creatorId = await seedAccount();
    const artwork = await prisma.artwork.create({
      data: {
        creatorAccountId: creatorId,
        slug: `artwork-${randomUUID()}`,
        title: '天下布武の陣羽織',
        maxSupply: 10,
        status: 'published',
      },
    });
    const listing = await prisma.listing.create({
      data: {
        artworkId: artwork.id,
        priceAmount: 3000,
        priceCurrency: 'JPY',
        status: 'active',
      },
    });
    const order = await prisma.order.create({
      data: {
        accountId: buyerId,
        ...orderSeedFields({ creatorAccountId: creatorId, totalAmount: 3000 }),
        totalAmount: 3000,
        totalCurrency: 'JPY',
        idempotencyKey: randomUUID(),
      },
    });
    const line = await prisma.orderLine.create({
      data: {
        orderId: order.id,
        listingId: listing.id,
        artworkId: artwork.id,
        artworkTitleSnapshot: '天下布武の陣羽織',
        creatorNameSnapshot,
        unitPriceAmount: 3000,
        unitPriceCurrency: 'JPY',
        quantity: 1,
        ...orderLineSeedFields({
          creatorAccountId: creatorId,
          unitPriceAmount: 3000,
          quantity: 1,
        }),
      },
    });
    return line.id;
  }

  it('注文時点のお名前を持てる', async () => {
    const lineId = await seedOrderLine('戦国工房');
    const line = await prisma.orderLine.findUnique({ where: { id: lineId } });
    expect(line?.creatorNameSnapshot).toBe('戦国工房');
  });

  it('作家さまが改名しても、注文の記録は動かない', async () => {
    /*
      ⚠️ **ここが芯。** 注文の記録は「そのとき何が表示されていたか」。
         マスタを引き直す実装に変わると、お客さまが受け取った控えと
         画面の表示が食い違う。
    */
    const lineId = await seedOrderLine('戦国工房');
    const line = await prisma.orderLine.findUnique({ where: { id: lineId } });
    const creatorId = line?.creatorAccountId ?? '';

    await repo.saveDisplayName(creatorId, validated('陣羽織屋あらため'));

    const after = await prisma.orderLine.findUnique({ where: { id: lineId } });
    expect(after?.creatorNameSnapshot).toBe('戦国工房');
  });

  it('お名前の無い方から買った注文は NULL のまま（推測で埋めない）', async () => {
    // ⚠️ この列より前の注文も NULL。あとから埋めると、当時の表示を偽る。
    const lineId = await seedOrderLine(null);
    const line = await prisma.orderLine.findUnique({ where: { id: lineId } });
    expect(line?.creatorNameSnapshot).toBeNull();
  });
});
