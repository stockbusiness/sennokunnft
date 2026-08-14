/**
 * 固定窓によるレート制限の判定。
 *
 * ⚠️ **ここは判定だけを行う。数を覚えておくのは呼び出し元（ポートの実装）。**
 * 時計も外から渡す。実装が自分で時計を読むと、テストで境界を確かめられない。
 *
 * 固定窓を選んだのは、**次に受け付けられる時刻を正確に言えるから**。
 * 相手へ `Retry-After` を返すとき、「たぶんこのくらい」ではなく
 * 「窓が変わるまであと何秒」と答えられる。
 *
 * ⚠️ **窓の境目では、短時間に上限の 2 倍まで通りうる。**
 * 窓の終わりに上限まで使い、窓が変わった直後にもう一度上限まで使えるため。
 * 本システムの用途では上限が実利用より桁で大きいので許容する
 * （`GET` は上限 3000/分に対し、1 セッションあたり実利用 12/分）。
 * 上限を実利用へ近づけるときは、この性質を思い出すこと。
 */

/** 窓の状態。呼び出し元が保持して渡す。 */
export interface RateLimitWindow {
  /** この窓が始まった時刻。 */
  readonly startedAt: Date;
  /** この窓で受け付けた数。 */
  readonly count: number;
}

export interface RateLimitInput {
  /** 1 窓あたりの上限。 */
  readonly limit: number;
  readonly windowMs: number;
  readonly now: Date;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** この窓であと何回受け付けられるか。 */
  readonly remaining: number;
  /**
   * 次に受け付けられるまでの秒数。
   *
   * 許可したときは `0`。拒否したときは**切り上げた秒数**を返す。
   * 切り下げると、相手がその時刻に送り直してもまだ窓が変わっておらず、
   * もう一度拒否されて「言われたとおりにしたのに通らない」ことになる。
   */
  readonly retryAfterSeconds: number;
}

export interface RateLimitResult {
  readonly decision: RateLimitDecision;
  /** 次回に渡す窓の状態。**拒否したときも数える**（後述）。 */
  readonly window: RateLimitWindow;
}

/**
 * 1 回ぶん消費する。
 *
 * ⚠️ **拒否した要求も数える。**
 * 数えないと、上限に達したあと送り続ける相手に対して
 * 窓が永遠に埋まらず、上限を超えた流量をそのまま受け続ける。
 * 「弾いた」ことと「無かったことにする」ことは違う。
 */
export function consumeFixedWindow(
  current: RateLimitWindow | null,
  input: RateLimitInput,
): RateLimitResult {
  const { limit, windowMs, now } = input;

  const expired = current === null || now.getTime() - current.startedAt.getTime() >= windowMs;
  const window: RateLimitWindow = expired ? { startedAt: now, count: 0 } : current;

  const nextCount = window.count + 1;
  const allowed = nextCount <= limit;
  const elapsed = now.getTime() - window.startedAt.getTime();
  const remainingMs = Math.max(0, windowMs - elapsed);

  return {
    decision: {
      allowed,
      remaining: Math.max(0, limit - nextCount),
      // 切り上げる。切り下げるとまだ窓が変わっておらず、また弾かれる。
      retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil(remainingMs / 1000)),
    },
    window: { startedAt: window.startedAt, count: nextCount },
  };
}
