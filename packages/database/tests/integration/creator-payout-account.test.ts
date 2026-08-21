import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../../generated/client';
import { PrismaPayoutAccountRepository } from '../../src/repositories/creator.repository';
import {
  createTestClient,
  integrationTestsAvailable,
  resetDatabase,
  violatesConstraint,
} from '../helpers/database';

/**
 * 作家さまのお振込先（P1-3・`UD-124` 決定 2026-08-21）。
 *
 * ⚠️ ここで見たいのは 4 つ。
 *  1. **平文の口座番号を置く列が無いこと**
 *  2. **1 人につき 1 件しか持てないこと**——「どちらへ振り込むか」を人が
 *     選ぶ形にすると、選び間違いが送金の間違いになる
 *  3. **伏せた表記の列に平文を入れられないこと**
 *  4. **本人確認書類の列が無いこと**（`UD-124`）
 */
const enabled = integrationTestsAvailable();
const suite = enabled ? describe : describe.skip;

const NOW = new Date('2026-08-21T00:00:00.000Z');

let prisma: PrismaClient;
let accounts: PrismaPayoutAccountRepository;
let accountId: string;

beforeAll(() => {
  if (!enabled) return;
  prisma = createTestClient();
  accounts = new PrismaPayoutAccountRepository(prisma);
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

function record(overrides: Record<string, unknown> = {}) {
  return {
    creatorAccountId: accountId,
    bankName: '千ノ国銀行',
    branchName: '本店',
    accountType: 'ordinary' as const,
    sealedAccountNumber: {
      ciphertext: 'Y2lwaGVy',
      nonce: 'bm9uY2U=',
      authTag: 'dGFn',
      keyVersion: 'v1',
      lastFour: '4567',
    },
    maskedAccountNumber: '***4567',
    accountHolderKana: 'センゴク タロウ',
    updatedAt: NOW,
    ...overrides,
  };
}

suite('保存と読み取り', () => {
  it('未登録なら null', async () => {
    expect(await accounts.find(accountId)).toBeNull();
  });

  it('登録して読み戻せる', async () => {
    const outcome = await accounts.save(record());
    // ⚠️ 初めての登録は「差し替え」ではない（知らせの文面が変わる）。
    expect(outcome.replaced).toBe(false);

    const found = await accounts.find(accountId);
    expect(found).toMatchObject({
      bankName: '千ノ国銀行',
      accountType: 'ordinary',
      maskedAccountNumber: '***4567',
    });
  });

  /*
    ⚠️ **1 人につき 1 件。** 主キーがアカウントIDなので、2 件目は作れず
       差し替えになる。「どちらへ振り込むか」を人が選ぶ形にしない。
  */
  it('2 回目は差し替えになる（2 件持てない）', async () => {
    await accounts.save(record());
    const outcome = await accounts.save(record({ bankName: '稲葉山信用金庫' }));
    expect(outcome.replaced).toBe(true);

    const rows = await prisma.creatorPayoutAccount.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.bankName).toBe('稲葉山信用金庫');
  });
});

suite('DB が止めること', () => {
  /*
    ⚠️ **伏せた表記の列に平文を入れる実装ミスを、DB の側でも止める。**
       アプリの `maskAccountNumber` を通していれば必ず `***` で始まる。
  */
  it('伏せていない番号は入らない', async () => {
    await expect(accounts.save(record({ maskedAccountNumber: '1234567' }))).rejects.toSatisfy(
      (error: unknown) => violatesConstraint(error, 'creator_payout_accounts_masked_is_masked'),
    );
  });

  it('知らない預金種別は入らない', async () => {
    await expect(accounts.save(record({ accountType: 'savings' }))).rejects.toSatisfy(
      (error: unknown) => violatesConstraint(error, 'creator_payout_accounts_type_known'),
    );
  });

  /*
    ⚠️ **空のまま登録できると、画面には「登録済み」と出るのに振り込めない。**
       `NOT NULL` だけでは空文字を止められない。
  */
  it.each([['bankName'], ['branchName'], ['accountHolderKana']])(
    '空文字の %s は入らない',
    async (field) => {
      await expect(accounts.save(record({ [field]: '   ' }))).rejects.toSatisfy((error: unknown) =>
        violatesConstraint(error, 'creator_payout_accounts_no_blanks'),
      );
    },
  );
});

suite('持たないと決めたもの', () => {
  /*
    ⚠️ **本人確認書類は取らない**（`UD-124` 決定 2026-08-21）。
       **持たないと決めたものは、列そのものを作らない**——列があると、
       いつか誰かが入れる。ここでその不在を釘付けにする。
  */
  it('本人確認書類やマイナンバーの列が無い', async () => {
    const columns = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'creator_payout_accounts'`,
    );
    const names = columns.map((row) => row.column_name);
    for (const forbidden of ['my_number', 'individual_number', 'document', 'identity', 'birth']) {
      expect(names.filter((name) => name.includes(forbidden))).toEqual([]);
    }
  });

  /*
    ⚠️ **平文の口座番号を置く列も無い。** 置けると、鍵の設定を忘れた配備で
       静かに平文が溜まる。
  */
  it('平文の口座番号を置く列が無い', async () => {
    const columns = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'creator_payout_accounts'`,
    );
    const names = columns.map((row) => row.column_name);
    // ⚠️ あるのは暗号文と伏せた表記だけ。
    expect(names).toContain('account_number_ciphertext');
    expect(names).toContain('masked_account_number');
    expect(names).not.toContain('account_number');
  });
});
