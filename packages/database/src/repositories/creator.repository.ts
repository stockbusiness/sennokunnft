import { isPayoutAccountType } from '@sengoku/domain';
import type {
  CreatorEarningsPort,
  CreatorLink,
  CreatorProfilePort,
  CreatorProfileRecord,
  PayoutAccountPort,
  PayoutAccountRecord,
  PayoutLineDraft,
} from '@sengoku/domain';
import type { PrismaClient } from '../../generated/client';

/**
 * 作家さまのプロフィール（実運営 指示書 P1-2）。
 *
 * ⚠️ **表示名は触らない。** あちらは `accounts` にあり、一意性の検査を
 * 伴う（`UD-102`）。ここで一緒に書くと、紹介文を直すたびに一意性の検査が
 * 走り、他人と被っていると紹介文まで保存できなくなる。
 */
export class PrismaCreatorProfileDetailRepository implements CreatorProfilePort {
  constructor(private readonly prisma: PrismaClient) {}

  async find(accountId: string): Promise<CreatorProfileRecord | null> {
    const row = await this.prisma.creatorProfile.findUnique({ where: { accountId } });
    return row === null ? null : toRecord(row);
  }

  /**
   * 保存する。
   *
   * ⚠️ **画像の鍵に触れない。** 画像は別の経路（アップロード）で入る。
   * ここで `undefined` を書くと、紹介文を直すたびに画像が消える。
   */
  async save(input: {
    readonly accountId: string;
    readonly shopName: string | null;
    readonly bio: string | null;
    readonly links: readonly CreatorLink[];
    readonly invoiceNumber: string | null;
    readonly now: Date;
  }): Promise<CreatorProfileRecord> {
    const row = await this.prisma.creatorProfile.upsert({
      where: { accountId: input.accountId },
      create: {
        accountId: input.accountId,
        shopName: input.shopName,
        bio: input.bio,
        links: toJson(input.links),
        invoiceNumber: input.invoiceNumber,
        createdAt: input.now,
        updatedAt: input.now,
      },
      update: {
        shopName: input.shopName,
        bio: input.bio,
        links: toJson(input.links),
        invoiceNumber: input.invoiceNumber,
        updatedAt: input.now,
      },
    });
    return toRecord(row);
  }

  /** 画像の鍵だけを差し替える。⚠️ ほかの項目に触れない。 */
  async saveImageKey(input: {
    readonly accountId: string;
    readonly slot: 'icon' | 'cover';
    readonly key: string;
    readonly now: Date;
  }): Promise<void> {
    const field = input.slot === 'icon' ? { iconKey: input.key } : { coverKey: input.key };
    await this.prisma.creatorProfile.upsert({
      where: { accountId: input.accountId },
      create: { accountId: input.accountId, ...field, createdAt: input.now, updatedAt: input.now },
      update: { ...field, updatedAt: input.now },
    });
  }
}

/**
 * 締めた精算の明細。
 *
 * ⚠️ **見込みの明細と同じ形で返す。** 形が違うと、画面が「締めた月」と
 * 「締めていない月」で 2 通りになり、片方だけ直す事故が起きる。
 */
export class PrismaCreatorEarningsRepository implements CreatorEarningsPort {
  constructor(private readonly prisma: PrismaClient) {}

  async linesOf(payoutId: string): Promise<readonly PayoutLineDraft[]> {
    const rows = await this.prisma.payoutLine.findMany({
      where: { payoutId },
      orderBy: [{ createdAt: 'asc' }],
      select: {
        orderId: true,
        orderNumber: true,
        artworkTitleSnapshot: true,
        grossAmount: true,
        feeRateBps: true,
        feeAmount: true,
        netAmount: true,
        isClawback: true,
      },
    });
    return rows;
  }
}

/**
 * JSON の列へ書く形にする。
 *
 * ⚠️ **Prisma の `InputJsonValue` は配列の型を素直に受けない。** ここで
 * 一度ただの配列へ落とす。落とす場所を 1 か所にしておけば、あとから
 * 項目が増えたときに直す場所も 1 か所で済む。
 */
function toJson(links: readonly CreatorLink[]): { label: string; url: string }[] {
  return links.map((link) => ({ label: link.label, url: link.url }));
}

function toRecord(row: {
  accountId: string;
  shopName: string | null;
  bio: string | null;
  links: unknown;
  iconKey: string | null;
  coverKey: string | null;
  invoiceNumber: string | null;
}): CreatorProfileRecord {
  return {
    accountId: row.accountId,
    shopName: row.shopName,
    bio: row.bio,
    links: toLinks(row.links),
    iconKey: row.iconKey,
    coverKey: row.coverKey,
    invoiceNumber: row.invoiceNumber,
  };
}

/**
 * JSON の列を読む。
 *
 * ⚠️ **形の合わない行を落とす。** DB の CHECK は配列であることまでしか
 * 縛れない。中身が壊れていたら、画面を壊すより落とすほうがまだよい。
 */
function toLinks(value: unknown): readonly CreatorLink[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): CreatorLink[] => {
    if (typeof item !== 'object' || item === null) {
      return [];
    }
    const record = item as Record<string, unknown>;
    const label = record.label;
    const url = record.url;
    if (typeof label !== 'string' || typeof url !== 'string') {
      return [];
    }
    return [{ label, url }];
  });
}

/**
 * 作家さまのお振込先（P1-3）。
 *
 * ⚠️ **口座番号は包んだまま出し入れする。** このクラスは中身を知らない。
 * 解けるのは、鍵を持つ側（`PayoutAccountCipherPort`）だけ。
 *
 * ⚠️ **消す口を置かない。** 「登録をやめる」は、いまのところ要らない
 * （振り込めなくなるだけで、作家さまの得にならない）。要るとなったら、
 * そのときに**何が起きるか**を決めてから足す。
 */
export class PrismaPayoutAccountRepository implements PayoutAccountPort {
  constructor(private readonly prisma: PrismaClient) {}

  async find(creatorAccountId: string): Promise<PayoutAccountRecord | null> {
    const row = await this.prisma.creatorPayoutAccount.findUnique({
      where: { creatorAccountId },
    });
    if (row === null) {
      return null;
    }
    if (!isPayoutAccountType(row.accountType)) {
      /*
        ⚠️ **知らない種別を黙って通さない。** DB の CHECK が守っているので
           ここへは来ないはずだが、来たなら CHECK が外れているということ。
           そのまま振込の画面へ出すより、止めたほうがよい。
      */
      throw new Error(`unknown payout account type: ${row.accountType}`);
    }
    return {
      creatorAccountId: row.creatorAccountId,
      bankName: row.bankName,
      branchName: row.branchName,
      accountType: row.accountType,
      sealedAccountNumber: {
        ciphertext: row.accountNumberCiphertext,
        nonce: row.accountNumberNonce,
        authTag: row.accountNumberAuthTag,
        keyVersion: row.keyVersion,
        /*
          ⚠️ **`lastFour` は保存していない。** 伏せた表記から取り出す。
             同じ値を 2 か所に持つと、片方だけ古くなる。
        */
        lastFour: row.maskedAccountNumber.replace(/^\*+/u, ''),
      },
      maskedAccountNumber: row.maskedAccountNumber,
      accountHolderKana: row.accountHolderKana,
      updatedAt: row.updatedAt,
    };
  }

  async save(record: PayoutAccountRecord): Promise<{ readonly replaced: boolean }> {
    const data = {
      bankName: record.bankName,
      branchName: record.branchName,
      accountType: record.accountType,
      accountNumberCiphertext: record.sealedAccountNumber.ciphertext,
      accountNumberNonce: record.sealedAccountNumber.nonce,
      accountNumberAuthTag: record.sealedAccountNumber.authTag,
      keyVersion: record.sealedAccountNumber.keyVersion,
      maskedAccountNumber: record.maskedAccountNumber,
      accountHolderKana: record.accountHolderKana,
      updatedAt: record.updatedAt,
    };

    /*
      ⚠️ **差し替えだったかを返す。** 知らせの文面が変わる——初めての登録に
         「変更されました」と届くと、身に覚えのない知らせになる。
    */
    const existing = await this.prisma.creatorPayoutAccount.findUnique({
      where: { creatorAccountId: record.creatorAccountId },
      select: { creatorAccountId: true },
    });

    await this.prisma.creatorPayoutAccount.upsert({
      where: { creatorAccountId: record.creatorAccountId },
      create: { creatorAccountId: record.creatorAccountId, ...data },
      update: data,
    });
    return { replaced: existing !== null };
  }
}
