import {
  consumeFixedWindow,
  type RateLimitDecision,
  type RateLimitWindow,
  type RateLimiterPort,
} from '@sengoku/domain';

/**
 * レート制限の数え役（プロセス内メモリ）。
 *
 * ⚠️ **台数を増やすと、実効の上限が台数倍になる。**
 * 各プロセスが自分の数しか知らないため、2 台なら 2 倍まで通る。
 * nonce や冪等キーのように「効かなくなる」のではなく「静かに緩む」ので、
 * **壊れていることが外から見えない。**
 *
 * ⚠️ **台数を増やすときは、上限を台数で割るか、共有の実装へ差し替える。**
 * 置き場所（Redis / DB）はホスティング（`UD-1101`）が決まってから選ぶ。
 * 差し替えは `RateLimiterPort` の実装を入れ替えるだけで済む。
 *
 * 現時点で本実装を選ぶ理由:
 *  - 1 リクエストごとに共有ストアへ書くと、その書き込み自体が
 *    負荷の増幅になる（上限 3000/分の経路で毎回往復する）
 *  - 台数がまだ決まっていない（`UD-1101` 未決定）
 *  - IP 単位の粗い制限は WAF / LB 側で別途かける前提
 */
export class InMemoryRateLimiter implements RateLimiterPort {
  private readonly windows = new Map<string, RateLimitWindow>();

  /**
   * 掃除を走らせる間隔の目安。
   *
   * ⚠️ **放っておくと表が伸び続ける。** 鍵IDは限られているので通常は
   * 増えないが、実装の都合で bucket を細かくしたときに効いてくる。
   */
  private lastSweptAt = 0;
  private static readonly SWEEP_INTERVAL_MS = 5 * 60 * 1000;

  consume(input: {
    bucket: string;
    limit: number;
    windowMs: number;
    now: Date;
  }): Promise<RateLimitDecision> {
    this.sweep(input.now, input.windowMs);

    const current = this.windows.get(input.bucket) ?? null;
    const result = consumeFixedWindow(current, {
      limit: input.limit,
      windowMs: input.windowMs,
      now: input.now,
    });
    this.windows.set(input.bucket, result.window);
    return Promise.resolve(result.decision);
  }

  /** 窓が終わった項目を捨てる。 */
  private sweep(now: Date, windowMs: number): void {
    const nowMs = now.getTime();
    if (nowMs - this.lastSweptAt < InMemoryRateLimiter.SWEEP_INTERVAL_MS) {
      return;
    }
    this.lastSweptAt = nowMs;
    for (const [bucket, window] of this.windows) {
      if (nowMs - window.startedAt.getTime() >= windowMs) {
        this.windows.delete(bucket);
      }
    }
  }
}
