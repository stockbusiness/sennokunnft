import type { AccountLookupPort, AccountRecord } from '@sengoku/auth';
import type { PrismaClient } from '../../generated/client';
import type { Account as AccountRow } from '../../generated/client';

function toAccount(row: AccountRow): AccountRecord {
  return {
    id: row.id,
    authProvider: row.authProvider,
    authSubject: row.authSubject,
    // ⚠️ ロールは必ず DB の値を使う。トークンのクレームからは読まない。
    role: row.role,
    status: row.status,
    // ⚠️ 人事の印も DB の値（`UD-803`）。
    isOwner: row.isOwner,
    // ⚠️ 照合用の値だけ（`UD-121`）。平文は列に無い（`UD-503`）。
    emailHash: row.emailHash,
    // ⚠️ 二要素で入った記録（P0-7）。認可には使わない。
    lastAal2At: row.lastAal2At,
  };
}

/**
 * アカウントの解決。
 *
 * 認証の正は外部（Supabase Auth）にあり、本テーブルは
 * 「その利用者が本システム内で何者か」だけを持つ。
 * パスワードや資格情報は保持しない。
 */
export class PrismaAccountRepository implements AccountLookupPort {
  constructor(private readonly prisma: PrismaClient) {}

  async findByAuthSubject(provider: string, subject: string): Promise<AccountRecord | null> {
    const row = await this.prisma.account.findUnique({
      where: { authProvider_authSubject: { authProvider: provider, authSubject: subject } },
    });
    return row === null ? null : toAccount(row);
  }

  /**
   * 初回アクセス時にアカウントを作る（Just-In-Time provisioning）。
   *
   * ⚠️ **作成されるロールは常に `buyer`。**
   * 認証プロバイダ側の任意項目には利用者が改変しうる経路があるため、
   * そこを起点に権限を与えない。昇格は運営操作でのみ行う。
   *
   * 同時に 2 リクエストが来ても 1 行しか作られないよう upsert を使う。
   * UNIQUE(authProvider, authSubject) が最終的な担保。
   */
  async provision(
    provider: string,
    subject: string,
    emailHash: string | null,
  ): Promise<AccountRecord> {
    const row = await this.prisma.account.upsert({
      where: { authProvider_authSubject: { authProvider: provider, authSubject: subject } },
      create: {
        authProvider: provider,
        authSubject: subject,
        role: 'buyer',
        status: 'active',
        // ⚠️ 照合用の値のみ（`UD-121`）。平文を入れる列はそもそも無い。
        emailHash,
      },
      // 既に存在するなら何も変えない。ここで role を書き換えると昇格経路になる。
      // ⚠️ 照合用の値もここでは触らない。作成と更新で書く条件を変えると、
      //    どちらの経路で入った値なのか追えなくなる。更新は
      //    `rememberEmailHash` が担う。
      update: {},
    });
    return toAccount(row);
  }

  /**
   * 照合用のメール値を覚え直す（`UD-121`）。
   *
   * ⚠️ **`null` では消さない。** 鍵を持たない配備や、メールを載せない
   * トークンで一度通っただけで、既にある照合値が失われる。
   * 「引けなくなった」は、問い合わせの最中に初めて気付く類の壊れ方になる。
   */
  async rememberEmailHash(accountId: string, emailHash: string | null): Promise<void> {
    if (emailHash === null) {
      return;
    }
    await this.prisma.account.update({
      where: { id: accountId },
      data: { emailHash },
    });
  }

  /**
   * 二要素で入ったことを覚える（P0-7 の 8 番目・`UD-801` の段 1）。
   *
   * ⚠️ **消さない側へ倒す。** `aal1` で入り直したときにここは呼ばれない
   * （呼び出し側が `aal2` のときだけ呼ぶ）。二要素を外したことは
   * こちらからは分からないので、判定の側で期限を切る。
   *
   * ⚠️ **時刻を巻き戻さない。** 別の要求が先に新しい時刻を書いていたら
   * そのまま。並行した要求どうしで古い値が勝つと、記録が実際より
   * 古く見え、判定が余計に厳しくなる。
   */
  async rememberMfa(accountId: string, at: Date): Promise<void> {
    await this.prisma.account.updateMany({
      where: {
        id: accountId,
        OR: [{ lastAal2At: null }, { lastAal2At: { lt: at } }],
      },
      data: { lastAal2At: at },
    });
  }
}
