import { describe, expect, it } from 'vitest';
import {
  pendingRepairCount,
  planReservedCountRepair,
  planReservedCountRepairResolution,
  type ReservedCountRepairCommand,
  type ReservedCountRepairRecord,
  type ReservedCountRepairSubject,
} from '../src/index';

/**
 * 押さえのずれを直す判定（`ADMIN_OPERATIONS_GAP.md` §I）。
 *
 * ⚠️ **ここが唯一の関門である。** リポジトリ側は行を掴んで数を書くだけで、
 * 「直してよいか」の判断はここにしか無い。歯止めを 1 本外したら必ず
 * どれかが落ちる、という形で書く。
 */

const REASON = '返金の二重解放を直したため、押さえを数え直す';

function order(heldQuantity: number, issuedCount: number, orderId = 'order-1') {
  return {
    orderId,
    orderNumber: 'SG-0001',
    orderStatus: 'paid',
    heldQuantity,
    issuedCount,
  };
}

function command(overrides: Partial<ReservedCountRepairCommand> = {}): ReservedCountRepairCommand {
  return {
    artworkId: 'artwork-1',
    observedReservedCount: 3,
    reason: REASON,
    causeState: 'identified',
    ...overrides,
  };
}

function subject(overrides: Partial<ReservedCountRepairSubject> = {}): ReservedCountRepairSubject {
  return {
    reservedCount: 3,
    issuedCount: 0,
    maxSupply: 100,
    orders: [order(1, 0)],
    ...overrides,
  };
}

describe('planReservedCountRepair', () => {
  it('多すぎる押さえを、仮引当から数え直した値へ直す', () => {
    const decision = planReservedCountRepair(command(), subject());

    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect({
      before: decision.plan.before,
      after: decision.plan.after,
      difference: decision.plan.difference,
      direction: decision.plan.direction,
    }).toEqual({ before: 3, after: 1, difference: 2, direction: 'over' });
  });

  it('足りない押さえは増やす向きになる', () => {
    const decision = planReservedCountRepair(
      command({ observedReservedCount: 1 }),
      subject({ reservedCount: 1, orders: [order(2, 0), order(1, 0, 'order-2')] }),
    );

    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect({ after: decision.plan.after, direction: decision.plan.direction }).toEqual({
      after: 3,
      direction: 'under',
    });
  });

  /*
    ⚠️ **一覧と同じ算術を使っていることの証。** 発行済みのぶんは
       押さえから抜ける（決定 A）。ここが別実装になると、画面が見せた
       数と違う数へ直すことになる。
  */
  it('発行済みのぶんは、あるべき押さえから外れる', () => {
    const decision = planReservedCountRepair(
      command({ observedReservedCount: 5 }),
      subject({ reservedCount: 5, orders: [order(3, 2)] }),
    );

    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.plan.after).toBe(1);
  });

  it('直す前の内訳をまるごと持ち回る', () => {
    const orders = [order(2, 1), order(1, 0, 'order-2')];
    const decision = planReservedCountRepair(
      command({ observedReservedCount: 9 }),
      subject({ reservedCount: 9, orders }),
    );

    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    // ⚠️ 「9 → 2」だけでは後から原因を辿れない。内訳が要る。
    expect(decision.plan.snapshot).toEqual(orders);
  });

  it('原因が分からないまま直したことを、そのまま持ち回る', () => {
    const decision = planReservedCountRepair(command({ causeState: 'unknown' }), subject());

    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.plan.causeState).toBe('unknown');
  });

  it('理由の前後の空白は落とす', () => {
    const decision = planReservedCountRepair(command({ reason: `  ${REASON}  ` }), subject());

    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.plan.reason).toBe(REASON);
  });

  describe('直さない場合', () => {
    it('理由が空なら直さない', () => {
      expect(planReservedCountRepair(command({ reason: '   ' }), subject())).toEqual({
        ok: false,
        refusal: 'reason_required',
      });
    });

    it('理由が短すぎるなら直さない', () => {
      expect(planReservedCountRepair(command({ reason: '直した' }), subject())).toEqual({
        ok: false,
        refusal: 'reason_required',
      });
    });

    it('理由が長すぎるなら直さない', () => {
      expect(planReservedCountRepair(command({ reason: 'あ'.repeat(1001) }), subject())).toEqual({
        ok: false,
        refusal: 'reason_required',
      });
    });

    /*
      ⚠️ **要の歯止め。** 画面を開いてから押すまでに正常なご注文が入ると、
         古い数字で上書きして**逆にずれを作る。**
    */
    it('画面が見た押さえと今の押さえが違えば直さない', () => {
      expect(
        planReservedCountRepair(
          command({ observedReservedCount: 3 }),
          subject({ reservedCount: 4 }),
        ),
      ).toEqual({ ok: false, refusal: 'stale_view' });
    });

    /*
      ⚠️ **古い画面に「ずれていません」と返さない。** 直ったと誤解される。
         `stale_view` の判定は `no_drift` より先。
    */
    it('画面が古く、かつ今はずれていない場合も、古さのほうを返す', () => {
      expect(
        planReservedCountRepair(
          command({ observedReservedCount: 3 }),
          subject({ reservedCount: 2, orders: [order(2, 0)] }),
        ),
      ).toEqual({ ok: false, refusal: 'stale_view' });
    });

    it('もうずれていないなら直さない', () => {
      expect(
        planReservedCountRepair(
          command({ observedReservedCount: 2 }),
          subject({ reservedCount: 2, orders: [order(2, 0)] }),
        ),
      ).toEqual({ ok: false, refusal: 'no_drift' });
    });

    /*
      ⚠️ **これはずれではなく、すでに売り越している。** 直せば真実だが、
         `artworks_supply_within_max` が拒む。この口で決めてよい話では
         ない（ご注文を取り消すか上限を上げるかの判断が要る）。
    */
    it('直すと在庫の上限を超えるなら直さない', () => {
      expect(
        planReservedCountRepair(
          command({ observedReservedCount: 1 }),
          subject({ reservedCount: 1, issuedCount: 8, maxSupply: 10, orders: [order(5, 0)] }),
        ),
      ).toEqual({ ok: false, refusal: 'exceeds_max_supply' });
    });

    it('ちょうど上限に収まるなら直す', () => {
      const decision = planReservedCountRepair(
        command({ observedReservedCount: 1 }),
        subject({ reservedCount: 1, issuedCount: 8, maxSupply: 10, orders: [order(2, 0)] }),
      );

      expect(decision.ok).toBe(true);
      if (!decision.ok) return;
      expect(decision.plan.after).toBe(2);
    });

    /*
      ⚠️ **減らす側は上限に触れない。** 上限の検査が減らす側まで
         巻き込んでいないことを押さえる。
    */
    it('上限を超えている作品でも、減らす向きなら直せる', () => {
      const decision = planReservedCountRepair(
        command({ observedReservedCount: 9 }),
        subject({ reservedCount: 9, issuedCount: 8, maxSupply: 10, orders: [order(1, 0)] }),
      );

      expect(decision.ok).toBe(true);
      if (!decision.ok) return;
      expect(decision.plan.after).toBe(1);
    });
  });

  /*
    ⚠️ **仮引当が 1 件も無いのに押さえが立っている作品。** あるべき値は
       0 で、これを「対象外」にすると、いちばん分かりやすいずれが
       直せないまま残る。
  */
  it('仮引当が 1 件も無ければ、あるべき押さえは 0', () => {
    const decision = planReservedCountRepair(
      command({ observedReservedCount: 4 }),
      subject({ reservedCount: 4, orders: [] }),
    );

    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect({ after: decision.plan.after, direction: decision.plan.direction }).toEqual({
      after: 0,
      direction: 'over',
    });
  });
});

function repairRecord(
  overrides: Partial<ReservedCountRepairRecord> = {},
): ReservedCountRepairRecord {
  return {
    id: 'repair-1',
    artworkId: 'artwork-1',
    artworkTitle: '試験の作品',
    before: 3,
    after: 1,
    difference: 2,
    direction: 'over',
    reason: REASON,
    causeState: 'unknown',
    snapshot: [],
    repairedByAccountId: 'account-1',
    repairedAt: new Date('2026-08-24T00:00:00Z'),
    resolvedAt: null,
    resolvedByAccountId: null,
    resolutionNote: null,
    ...overrides,
  };
}

describe('planReservedCountRepairResolution', () => {
  const NOTE = '返金の二重解放が原因だった。PR #86 で修正済み';

  it('原因未特定の積み残しは、分かったことを書けば閉じられる', () => {
    expect(planReservedCountRepairResolution(repairRecord(), `  ${NOTE}  `)).toEqual({
      ok: true,
      note: NOTE,
    });
  });

  it('何が分かったのかを書かないと閉じられない', () => {
    expect(planReservedCountRepairResolution(repairRecord(), '解決')).toEqual({
      ok: false,
      refusal: 'note_required',
    });
  });

  it('長すぎるメモも受け付けない', () => {
    expect(planReservedCountRepairResolution(repairRecord(), 'あ'.repeat(1001))).toEqual({
      ok: false,
      refusal: 'note_required',
    });
  });

  it('原因が分かったうえで直したものは、はじめから積み残しではない', () => {
    expect(
      planReservedCountRepairResolution(repairRecord({ causeState: 'identified' }), NOTE),
    ).toEqual({ ok: false, refusal: 'not_pending' });
  });

  it('すでに閉じたものは二度閉じられない', () => {
    expect(
      planReservedCountRepairResolution(
        repairRecord({ resolvedAt: new Date('2026-08-24T01:00:00Z') }),
        NOTE,
      ),
    ).toEqual({ ok: false, refusal: 'already_resolved' });
  });
});

describe('pendingRepairCount', () => {
  /*
    ⚠️ **この数がこの機能の心臓部。** 整合性チェックは修復で 0 件に戻るが、
       この数は残る。直したことで赤が消えるのを許さないためにある。
  */
  it('原因未特定で、まだ閉じていないものだけ数える', () => {
    expect(
      pendingRepairCount([
        repairRecord({ id: 'a', causeState: 'unknown', resolvedAt: null }),
        repairRecord({ id: 'b', causeState: 'unknown', resolvedAt: null }),
        repairRecord({ id: 'c', causeState: 'identified', resolvedAt: null }),
        repairRecord({ id: 'd', causeState: 'unknown', resolvedAt: new Date() }),
      ]),
    ).toBe(2);
  });

  it('1 件も無ければ 0', () => {
    expect(pendingRepairCount([])).toBe(0);
  });
});
