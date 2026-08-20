import type { IssuanceRetry, SupplyReconciliation } from '../entitlement/issuance';
import type { DomainError } from '../shared/errors';
import type { Result } from '../shared/result';

/**
 * 受取権の発行の口（P0-1）。
 *
 * ⚠️ **発行すべき注文は「導出」する。** 待ち行列の表を作って行を足す形に
 * すると、「行の入れ忘れ」「行だけ残る」という**実物と食い違う壊れ方**が
 * 新しく増える。決済が済んでいるのに受取権が足りない注文は、注文と
 * 受取権から必ず導けるので、取りこぼしても次の掃き出しで拾い直せる。
 */

/** 発行が要る注文。⚠️ 購入者・金額は載せない。掃き出しに要らない。 */
export interface IssuanceCandidate {
  readonly orderId: string;
  readonly orderNumber: string;
}

/** 1 注文ぶんの発行の結果。 */
export interface IssuanceOutcome {
  readonly orderId: string;
  readonly orderNumber: string;
  /** このとき作った枚数。0 は「すでに揃っていた」。 */
  readonly issued: number;
  /** 作った受取権のID。⚠️ 平文の受取トークンは含めない。 */
  readonly entitlementIds: readonly string[];
}

export interface EntitlementIssuanceRepository {
  /**
   * 発行が要る注文を拾う。
   *
   * ⚠️ **決済が済んだ注文だけ。** 「成功しそう」で拾わない。
   * ⚠️ 再試行の時刻が来ていない注文と、上限を使い切った注文は拾わない。
   */
  listPending(limit: number, now: Date): Promise<IssuanceCandidate[]>;

  /**
   * 1 注文ぶんの不足を埋める。
   *
   * ⚠️ **作品行をロックしてから数える。** ロックせずに数えると、
   * 同時に走った 2 本が同じ「不足数」を読んで、両方が作る。
   *
   * ⚠️ **受取権を作るのと在庫カウンタを動かすのは同じトランザクション。**
   * 分けると、片方だけ成った状態で落ちたときに数が合わなくなる。
   *
   * 何度呼んでも足りない分だけを作る（冪等）。
   */
  issueForOrder(orderId: string, now: Date): Promise<Result<IssuanceOutcome, DomainError>>;

  /**
   * 失敗を記録し、次にいつ試すかを決めて返す。
   *
   * ⚠️ **試行回数の加算はここで行う。** 呼び出し元が「読んで、足して、書く」
   * 形にすると、同時に 2 本走ったときに両方が同じ値を読み、**2 回失敗した
   * のに 1 回しか数えられない**。加算は DB の中で 1 手に済ませる。
   *
   * ⚠️ **符号だけを残す。** 例外の本文には個人情報や内部の詳細が混ざりうる。
   */
  recordFailure(input: {
    readonly orderId: string;
    readonly code: string;
    readonly now: Date;
  }): Promise<IssuanceRetry>;

  /**
   * 受取権の件数と `issuedCount` の食い違いを数える。
   *
   * ⚠️ **直さない。** どちらが正しいかは場合によって逆で、機械が寄せると
   * 事故の跡が消える。見つけて人へ渡すところまでが仕事。
   */
  reconcile(): Promise<SupplyReconciliation[]>;
}
