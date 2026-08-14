import type { CommonUserLink } from '../identity/common-user';

/**
 * 紐付け状態の永続化境界。
 *
 * ⚠️ **`save` は「現在の状態が期待どおりなら書く」形にしてある。**
 * 解決は複数の経路から同時に走りうる（ログイン直後のベストエフォートと、
 * 再試行の掃き出し）。素の UPDATE だと、後から来た古い結果が
 * 新しい結果を踏み潰す。
 */
export interface CommonUserLinkRepository {
  findByAccountId(accountId: string): Promise<CommonUserLink | null>;

  /**
   * 再試行の対象を取り出す。
   *
   * `PENDING` / `UNRESOLVED` のうち、次回時刻を過ぎたものだけを返す。
   * `RESOLVED` / `CONFLICT` / `ERROR` は対象にしない。
   */
  listDue(now: Date, limit: number): Promise<readonly CommonUserLink[]>;

  /**
   * 状態を書き込む。
   *
   * `expectedAttemptCount` が現在値と一致しないときは書かず `false` を返す。
   * 一致を条件にするのは、同時に走った別の試行の結果を
   * 上書きしないため。
   */
  save(link: CommonUserLink, expectedAttemptCount: number): Promise<boolean>;
}
