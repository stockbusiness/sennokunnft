import type { RateLimitDecision } from '../rate-limit/fixed-window';

/**
 * レート制限の数え役。
 *
 * ⚠️ **プロセス内メモリに置く実装は、台数を増やすと上限が台数倍になる。**
 * nonce や冪等キーと違い、これは「効かなくなる」のではなく「緩くなる」。
 * 弱まり方が静かなので、**どこかに書いておかないと誰も気づかない。**
 * 台数を増やすときは、上限を台数で割るか、共有の実装へ差し替える。
 *
 * ポートにしてあるのは、その差し替えを**呼び出し側を変えずに**できるようにするため。
 * 置き場所（メモリ / Redis / DB）はホスティング（`UD-1101`）が決まってから選ぶ。
 */
export interface RateLimiterPort {
  /**
   * 1 回ぶん消費し、通してよいかを返す。
   *
   * @param bucket 数える単位。呼び出し元が「鍵ID＋メソッド」等を組み立てて渡す。
   */
  consume(input: {
    readonly bucket: string;
    readonly limit: number;
    readonly windowMs: number;
    readonly now: Date;
  }): Promise<RateLimitDecision>;
}
