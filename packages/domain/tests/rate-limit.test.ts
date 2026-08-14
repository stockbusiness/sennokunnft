import { describe, expect, it } from 'vitest';
import { consumeFixedWindow, type RateLimitWindow } from '../src';

const START = new Date('2026-08-14T00:00:00.000Z');
const MINUTE = 60_000;

function at(ms: number): Date {
  return new Date(START.getTime() + ms);
}

/** 上限まで連続して消費し、最後の状態を返す。 */
function fill(limit: number, now: Date): RateLimitWindow {
  let window: RateLimitWindow | null = null;
  for (let i = 0; i < limit; i += 1) {
    window = consumeFixedWindow(window, { limit, windowMs: MINUTE, now }).window;
  }
  if (window === null) throw new Error('limit は 1 以上であること');
  return window;
}

describe('固定窓のレート制限', () => {
  it('最初の 1 回は通る', () => {
    const { decision } = consumeFixedWindow(null, { limit: 3, windowMs: MINUTE, now: START });
    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(2);
    expect(decision.retryAfterSeconds).toBe(0);
  });

  it('上限ちょうどまでは通る（境界）', () => {
    const window = fill(3, START);
    expect(window.count).toBe(3);
    const { decision } = consumeFixedWindow(null, { limit: 3, windowMs: MINUTE, now: START });
    expect(decision.allowed).toBe(true);
  });

  it('上限を 1 超えると拒否する', () => {
    const filled = fill(3, START);
    const { decision } = consumeFixedWindow(filled, { limit: 3, windowMs: MINUTE, now: START });
    expect(decision.allowed).toBe(false);
    expect(decision.remaining).toBe(0);
  });

  it('拒否したときは待つべき秒数を返す', () => {
    const filled = fill(3, START);
    // 窓の開始から 20 秒経過 → 残り 40 秒。
    const { decision } = consumeFixedWindow(filled, {
      limit: 3,
      windowMs: MINUTE,
      now: at(20_000),
    });
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSeconds).toBe(40);
  });

  it('待つべき秒数を切り上げる', () => {
    // ⚠️ 切り下げると、言われた時刻に送り直してもまだ窓が変わっておらず、
    //    もう一度弾かれる。「言われたとおりにしたのに通らない」を作らない。
    const filled = fill(3, START);
    const { decision } = consumeFixedWindow(filled, {
      limit: 3,
      windowMs: MINUTE,
      now: at(20_500),
    });
    expect(decision.retryAfterSeconds).toBe(40);
  });

  it('待つべき秒数が 0 にならない', () => {
    // 窓の終わり際でも 0 を返すと、相手が即座に送り直して無駄に弾かれる。
    const filled = fill(3, START);
    const { decision } = consumeFixedWindow(filled, {
      limit: 3,
      windowMs: MINUTE,
      now: at(MINUTE - 1),
    });
    expect(decision.retryAfterSeconds).toBe(1);
  });

  it('窓が変わればまた通る', () => {
    const filled = fill(3, START);
    const { decision } = consumeFixedWindow(filled, {
      limit: 3,
      windowMs: MINUTE,
      now: at(MINUTE),
    });
    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(2);
  });

  it('拒否した要求も数える', () => {
    // ⚠️ 数えないと、上限に達したあと送り続ける相手に対して
    //    窓が埋まったままにならず、超過した流量を受け続ける。
    const filled = fill(3, START);
    const rejected = consumeFixedWindow(filled, { limit: 3, windowMs: MINUTE, now: START });
    expect(rejected.decision.allowed).toBe(false);
    expect(rejected.window.count).toBe(4);
  });

  it('窓の開始時刻は、窓が変わるまで動かない', () => {
    // 動いてしまうと、送り続けるかぎり窓が終わらない（＝永久に拒否）。
    const first = consumeFixedWindow(null, { limit: 3, windowMs: MINUTE, now: START });
    const second = consumeFixedWindow(first.window, {
      limit: 3,
      windowMs: MINUTE,
      now: at(30_000),
    });
    expect(second.window.startedAt.getTime()).toBe(START.getTime());
  });
});

describe('実運用の値で確かめる', () => {
  it('Wallet の 5 秒ポーリングを妨げない', () => {
    // ⚠️ OVEW Wallet の Claim 画面は DELIVERY_PENDING のあいだ
    //    5 秒間隔でポーリングする（1 セッションあたり毎分 12 回）。
    //    ここが弾かれると、症状は「受け取り画面が進まない」になり、
    //    レート制限が原因だと気づきにくい。
    const LIMIT = 3000;
    let window: RateLimitWindow | null = null;
    let rejected = 0;

    // 100 セッションが同時に 1 分間ポーリングした場合 = 1200 回。
    for (let i = 0; i < 100 * 12; i += 1) {
      const result = consumeFixedWindow(window, {
        limit: LIMIT,
        windowMs: MINUTE,
        now: at((i % 12) * 5000),
      });
      window = result.window;
      if (!result.decision.allowed) rejected += 1;
    }
    expect(rejected).toBe(0);
  });

  it('POST の上限は 1 分あたり 300 回', () => {
    const LIMIT = 300;
    const filled = fill(LIMIT, START);
    expect(filled.count).toBe(LIMIT);
    const { decision } = consumeFixedWindow(filled, {
      limit: LIMIT,
      windowMs: MINUTE,
      now: START,
    });
    expect(decision.allowed).toBe(false);
  });
});
