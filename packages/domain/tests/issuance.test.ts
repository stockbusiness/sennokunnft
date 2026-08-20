import { describe, expect, it } from 'vitest';
import {
  ISSUANCE_MAX_ATTEMPTS,
  isIssuanceDue,
  planIssuance,
  reconcileSupply,
  scheduleIssuanceRetry,
} from '../src/entitlement/issuance';

/**
 * 受取権の発行（P0-1）。
 *
 * ⚠️ ここで守りたいのは 4 つ。
 *   1. **売った数だけ、1 枚ずつ作ること。** まとめて 1 枚にしない。
 *   2. **同じ知らせが何度来ても増えないこと。** 数えるのは実物。
 *   3. **途中で落ちても、不足分だけ再開できること。**
 *   4. **押さえた枠を超えないこと。** 超えたら止めて、人へ渡す。
 */

const NOW = new Date('2026-08-20T00:00:00.000Z');

/** 上限 10・3 枠を押さえ済み・まだ 1 枚も発行していない作品。 */
const COUNTERS = { maxSupply: 10, reservedCount: 3, issuedCount: 0 } as const;

describe('不足分を数えて作る', () => {
  it('数量 3 なら 3 枚ぶんの計画を返す', () => {
    const plan = planIssuance({ quantity: 3, alreadyIssued: 0, counters: COUNTERS });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.missing).toBe(3);
    // ⚠️ 1 権利 1 レコード。数量をまとめて 1 枚にしない。
    expect(plan.value.units).toHaveLength(3);
  });

  it('シリアル番号が重ならない（作品の中の通し番号）', () => {
    const plan = planIssuance({ quantity: 3, alreadyIssued: 0, counters: COUNTERS });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const serials = plan.value.units.map((unit) => unit.serialNo);
    expect(serials).toEqual([1, 2, 3]);
    expect(new Set(serials).size).toBe(3);
  });

  it('すでに発行済みの分だけ番号を進める', () => {
    // 5 枚出ている作品の次は 6 番から。
    const plan = planIssuance({
      quantity: 2,
      alreadyIssued: 0,
      counters: { maxSupply: 10, reservedCount: 2, issuedCount: 5 },
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.units.map((unit) => unit.serialNo)).toEqual([6, 7]);
  });

  it('注文明細の中の通し番号は 0 から連番になる（冪等の鍵）', () => {
    const plan = planIssuance({ quantity: 3, alreadyIssued: 0, counters: COUNTERS });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.units.map((unit) => unit.unitIndex)).toEqual([0, 1, 2]);
  });
});

describe('同じ知らせが何度来ても増えない', () => {
  it('発行済みなら作る枚数が 0 になる（失敗にはしない）', () => {
    /*
      ⚠️ **同じ Webhook の 2 回目を失敗にしない。** 失敗にすると、
         Stripe は「届かなかった」と読んでさらに送り直す。
    */
    const plan = planIssuance({ quantity: 3, alreadyIssued: 3, counters: COUNTERS });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.missing).toBe(0);
    expect(plan.value.units).toEqual([]);
  });

  it('発行済みならカウンタも動かさない', () => {
    const plan = planIssuance({ quantity: 3, alreadyIssued: 3, counters: COUNTERS });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    // ⚠️ ここが動くと、10 回受け取るたびに枠が減っていく。
    expect(plan.value.counters).toEqual(COUNTERS);
  });

  it('何度呼んでも同じ答えになる（10 回分）', () => {
    for (let i = 0; i < 10; i += 1) {
      const plan = planIssuance({ quantity: 3, alreadyIssued: 3, counters: COUNTERS });
      expect(plan.ok && plan.value.missing).toBe(0);
    }
  });

  it('売った数より多く発行されていたら止める', () => {
    // ⚠️ 黙って「もう足りている」と読まない。原因が残ったまま見えなくなる。
    const plan = planIssuance({ quantity: 3, alreadyIssued: 4, counters: COUNTERS });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error.code).toBe('ENTITLEMENT_OVER_ISSUED');
  });
});

describe('途中で落ちても不足分だけ再開する', () => {
  it('3 枚のうち 1 枚できていたら、残り 2 枚だけ作る', () => {
    const plan = planIssuance({
      quantity: 3,
      alreadyIssued: 1,
      // 1 枚ぶんは移動済み。押さえは 2、発行済みは 1。
      counters: { maxSupply: 10, reservedCount: 2, issuedCount: 1 },
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.missing).toBe(2);
    expect(plan.value.units.map((unit) => unit.unitIndex)).toEqual([1, 2]);
    // ⚠️ 番号は 1 番から採り直さない。既に 1 番が出ている。
    expect(plan.value.units.map((unit) => unit.serialNo)).toEqual([2, 3]);
  });

  it('再開しても押さえと発行済みの合計は変わらない', () => {
    const before = { maxSupply: 10, reservedCount: 2, issuedCount: 1 };
    const plan = planIssuance({ quantity: 3, alreadyIssued: 1, counters: before });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const after = plan.value.counters;
    // ⚠️ 合計が増えたらオーバーセル。移すだけで、増やさない。
    expect(after.reservedCount + after.issuedCount).toBe(before.reservedCount + before.issuedCount);
    expect(after).toEqual({ maxSupply: 10, reservedCount: 0, issuedCount: 3 });
  });
});

describe('押さえた枠を超えない', () => {
  it('押さえより多く発行しようとしたら止める', () => {
    /*
      ⚠️ 決済が済んだ注文の枠は解放しない決まり（決定 A）なので、通常は
         起こらない。起きたら在庫の記録が壊れているので、作らずに止める。
    */
    const plan = planIssuance({
      quantity: 3,
      alreadyIssued: 0,
      counters: { maxSupply: 10, reservedCount: 1, issuedCount: 0 },
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error.code).toBe('ENTITLEMENT_SUPPLY_MISMATCH');
  });

  it('数量が 0 や負なら受け付けない', () => {
    for (const quantity of [0, -1, 1.5]) {
      expect(planIssuance({ quantity, alreadyIssued: 0, counters: COUNTERS }).ok).toBe(false);
    }
  });
});

describe('失敗したときの再試行', () => {
  it('回を追うごとに間隔が伸びる', () => {
    const first = scheduleIssuanceRetry(0, NOW);
    const second = scheduleIssuanceRetry(1, NOW);
    expect(first.nextAttemptAt).not.toBeNull();
    expect(second.nextAttemptAt).not.toBeNull();
    expect(second.nextAttemptAt!.getTime()).toBeGreaterThan(first.nextAttemptAt!.getTime());
  });

  it('上限を超えたら自動では試さない（人手に回す）', () => {
    const last = scheduleIssuanceRetry(ISSUANCE_MAX_ATTEMPTS - 1, NOW);
    expect(last.exhausted).toBe(true);
    // ⚠️ `null` は「もう時計では拾わない」の意味。
    expect(last.nextAttemptAt).toBeNull();
  });

  it('掃き出しは、時刻が来た行と一度も試していない行だけ拾う', () => {
    expect(isIssuanceDue({ nextAttemptAt: null, attemptCount: 0 }, NOW)).toBe(true);
    expect(
      isIssuanceDue({ nextAttemptAt: new Date(NOW.getTime() - 1), attemptCount: 1 }, NOW),
    ).toBe(true);
    expect(
      isIssuanceDue({ nextAttemptAt: new Date(NOW.getTime() + 60_000), attemptCount: 1 }, NOW),
    ).toBe(false);
  });

  it('上限に達した行は、時刻が来ていても拾わない', () => {
    // ⚠️ 拾い続けると、直らない失敗が掃き出しの枠を食い、直る失敗が遅れる。
    expect(isIssuanceDue({ nextAttemptAt: null, attemptCount: ISSUANCE_MAX_ATTEMPTS }, NOW)).toBe(
      false,
    );
  });
});

describe('件数の食い違いを見つける', () => {
  it('カウンタと受取権の数が合っていれば何も返さない', () => {
    expect(reconcileSupply([{ artworkId: 'a', issuedCount: 3, entitlementCount: 3 }])).toEqual([]);
  });

  it('食い違う作品だけを、向きが分かる形で返す', () => {
    const found = reconcileSupply([
      { artworkId: 'ok', issuedCount: 3, entitlementCount: 3 },
      // カウンタが多い＝発行の取りこぼし。
      { artworkId: 'missing', issuedCount: 5, entitlementCount: 3 },
      // 受取権が多い＝二重発行。
      { artworkId: 'extra', issuedCount: 2, entitlementCount: 4 },
    ]);
    expect(found).toHaveLength(2);
    // ⚠️ 符号で向きが分かるようにする。直し方が逆になるため。
    expect(found.find((row) => row.artworkId === 'missing')?.drift).toBe(2);
    expect(found.find((row) => row.artworkId === 'extra')?.drift).toBe(-2);
  });
});
