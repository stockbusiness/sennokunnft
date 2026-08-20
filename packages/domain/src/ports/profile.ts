import type { DomainError } from '../shared/errors';
import type { Result } from '../shared/result';
import type { ValidatedDisplayName } from '../account/display-name';

/**
 * 作家さまの表示名を読み書きする口（決定 2026-08-20）。
 *
 * ⚠️ **重複の判定は DB の UNIQUE に任せる。** 先に「使われていますか」と
 * 問い合わせてから書くと、同時に登録した 2 人が両方通る。書いてみて、
 * 断られたら `DISPLAY_NAME_TAKEN` へ翻訳する。
 *
 * ⚠️ **他人の表示名を書き換える口を作らない。** 名乗る名前は本人のもので、
 * 運営が勝手に変えるものではない。なりすましへの対応は、名前の書き換えでは
 * なくアカウントの停止（`status`）で行う。
 */

/** 画面が読む、自分のプロフィール。⚠️ 個人を特定する値は載せない。 */
export interface CreatorProfile {
  readonly accountId: string;
  /** ⚠️ まだ登録していなければ `null`。 */
  readonly displayName: string | null;
}

export interface CreatorProfileRepository {
  find(accountId: string): Promise<CreatorProfile | null>;

  /**
   * 表示名を保存する。
   *
   * ⚠️ **検証済みの値だけを受け取る。** 生の文字列を受け取る形にすると、
   * 重複判定の鍵をここで作ることになり、正規化の実装が 2 か所になる。
   *
   * @returns 使われていれば `DISPLAY_NAME_TAKEN`。
   */
  saveDisplayName(
    accountId: string,
    name: ValidatedDisplayName,
  ): Promise<Result<CreatorProfile, DomainError>>;
}
