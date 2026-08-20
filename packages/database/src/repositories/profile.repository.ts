import {
  err,
  ok,
  domainError,
  type CreatorProfile,
  type CreatorProfileRepository,
  type DomainError,
  type Result,
  type ValidatedDisplayName,
} from '@sengoku/domain';
import { Prisma, type PrismaClient } from '../../generated/client';

/**
 * 作家さまの表示名（決定 2026-08-20）。
 *
 * ⚠️ **重複は DB の UNIQUE に任せる。** 先に「使われていますか」と
 * 問い合わせてから書くと、同時に登録した 2 人が両方通る。書いてみて、
 * 断られたら翻訳する。
 *
 * ⚠️ **鍵はアプリ側で作った値をそのまま書く。** `lower()` などの DB の
 * 関数で作り直さない。PostgreSQL の `lower()` は NFKC 正規化をしないので、
 * アプリ側と結果がずれる。ずれた鍵で UNIQUE を張ると、アプリが通した名前を
 * DB が弾く（あるいはその逆）ことになる。
 */
export class PrismaCreatorProfileRepository implements CreatorProfileRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async find(accountId: string): Promise<CreatorProfile | null> {
    const row = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: { id: true, displayName: true },
    });
    return row === null ? null : { accountId: row.id, displayName: row.displayName };
  }

  async saveDisplayName(
    accountId: string,
    name: ValidatedDisplayName,
  ): Promise<Result<CreatorProfile, DomainError>> {
    try {
      const row = await this.prisma.account.update({
        where: { id: accountId },
        // ⚠️ 表示名と鍵は必ず同時に書く。片方だけだと CHECK が止める。
        data: { displayName: name.value, displayNameKey: name.key },
        select: { id: true, displayName: true },
      });
      return ok({ accountId: row.id, displayName: row.displayName });
    } catch (error) {
      if (isUniqueViolation(error)) {
        /*
          ⚠️ **「使われています」へ翻訳する。** ここで例外のまま外へ出すと、
             500 になって「こちらの不具合」に見える。実際には、別の名前を
             考えていただければ済む話である。
        */
        return err(domainError('DISPLAY_NAME_TAKEN', 'display name is already taken'));
      }
      throw error;
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
