/**
 * 冪等キーの保管境界。
 *
 * ⚠️ **「探してから書く」ではなく「先に占有する」。**
 *
 * 探す → 無い → 処理する、という順番は、1 本ずつ来る前提でしか正しくない。
 * 同時に 2 本来ると、両方が「無い」を見て両方処理してしまう。
 * 読み取りと書き込みのあいだに隙間があるかぎり、`if` では塞げない。
 *
 * そのため `claim` で先に場所を取り、取れた 1 本だけが処理を進める。
 * 取れなかった側は、相手の結果を待つか受け取るかのどちらかになる。
 * 一意制約が判定そのものなので、競合しても二重には走らない。
 */

/** 占有中か、応答まで記録済みか。 */
export type IdempotencyState = 'in_progress' | 'completed';

export interface IdempotencyRecord {
  readonly requestDigest: string;
  readonly state: IdempotencyState;
  /** `completed` のときだけ入る。 */
  readonly statusCode: number | null;
  readonly responseBody: unknown;
}

export interface IdempotencyClaimInput {
  readonly actorAccountId: string;
  readonly key: string;
  readonly requestDigest: string;
  /**
   * 期限切れ判定に使う「いま」。**実装が自分で時計を読まない。**
   * 読んでしまうと、呼び出し側が使っている時計とずれる。
   * テストの固定時計と実装の実時刻が食い違うと、
   * 「テストでは期限切れ、本番では有効」のような差が生まれる。
   */
  readonly now: Date;
  readonly expiresAt: Date;
}

export interface IdempotencyClaimResult {
  /** true なら自分が占有した。処理を進めてよいのはこの場合だけ。 */
  readonly claimed: boolean;
  /** 占有できなかったときの既存レコード。 */
  readonly existing: IdempotencyRecord | null;
}

export interface IdempotencyStore {
  /**
   * キーを占有する。既に有効なレコードがあれば占有せず、それを返す。
   * 期限切れのレコードは未使用として扱う（占有できる）。
   */
  claim(input: IdempotencyClaimInput): Promise<IdempotencyClaimResult>;

  /** 処理が終わったので応答を記録する。 */
  complete(input: {
    readonly actorAccountId: string;
    readonly key: string;
    readonly statusCode: number;
    readonly responseBody: unknown;
  }): Promise<void>;

  /**
   * 占有を解放する。**処理が失敗したときに呼ぶ。**
   *
   * 解放しないと、一度失敗しただけのキーが期限切れまで再利用できなくなり、
   * 利用者が同じ操作をやり直せなくなる。
   */
  release(actorAccountId: string, key: string): Promise<void>;
}
