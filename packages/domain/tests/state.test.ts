import { describe, expect, it } from 'vitest';
import {
  ORDER_STATUSES,
  ENTITLEMENT_STATUSES,
  MINT_JOB_STATUSES,
  orderStateMachine,
  entitlementStateMachine,
  mintJobStateMachine,
  type StateMachine,
} from '../src/index';

/**
 * 状態遷移の網羅テスト（TEST_STRATEGY.md §3.5 T-1/T-2）。
 *
 * 「許可された遷移が成功する」だけでなく
 * 「許可されていない遷移がすべて失敗する」ことを全組み合わせで検証する。
 * 状態が増えたときにテストの追加漏れが起きないよう、表から総当たりする。
 */
function assertExhaustiveTransitions<S extends string>(
  machine: StateMachine<S>,
  allStates: readonly S[],
): void {
  for (const from of allStates) {
    for (const to of allStates) {
      const expected = machine.table[from].includes(to);
      const result = machine.transition(from, to);
      expect(result.ok, `${from} -> ${to} should be ${expected ? 'allowed' : 'rejected'}`).toBe(
        expected,
      );
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_STATE_TRANSITION');
      }
    }
  }
}

describe('注文の状態遷移', () => {
  it('全組み合わせが遷移表どおりに判定される', () => {
    assertExhaustiveTransitions(orderStateMachine, ORDER_STATUSES);
  });

  it('決済確定は pending からのみ到達できる', () => {
    const sources = ORDER_STATUSES.filter((status) =>
      orderStateMachine.canTransition(status, 'paid'),
    );
    expect(sources).toEqual(['pending']);
  });

  it('failed / expired / refunded は終端', () => {
    expect(orderStateMachine.isTerminal('failed')).toBe(true);
    expect(orderStateMachine.isTerminal('expired')).toBe(true);
    expect(orderStateMachine.isTerminal('refunded')).toBe(true);
  });
});

describe('受取権の状態遷移', () => {
  it('全組み合わせが遷移表どおりに判定される', () => {
    assertExhaustiveTransitions(entitlementStateMachine, ENTITLEMENT_STATUSES);
  });

  it('claimed は終端で、どの状態へも戻らない（INV-E2）', () => {
    expect(entitlementStateMachine.isTerminal('claimed')).toBe(true);
    for (const to of ENTITLEMENT_STATUSES) {
      expect(entitlementStateMachine.canTransition('claimed', to)).toBe(false);
    }
  });

  it('expired / revoked から claimed へは遷移できない（INV-E4）', () => {
    expect(entitlementStateMachine.canTransition('expired', 'claimed')).toBe(false);
    expect(entitlementStateMachine.canTransition('revoked', 'claimed')).toBe(false);
  });
});

describe('発行ジョブの状態遷移', () => {
  it('全組み合わせが遷移表どおりに判定される', () => {
    assertExhaustiveTransitions(mintJobStateMachine, MINT_JOB_STATUSES);
  });

  it('succeeded は終端（発行済みを取り消さない）', () => {
    expect(mintJobStateMachine.isTerminal('succeeded')).toBe(true);
  });

  it('processing から直接 cancelled にはできない（INV-M4）', () => {
    // 外部へ送信済みの可能性があるため、取消は状態機械の段階で禁止する。
    expect(mintJobStateMachine.canTransition('processing', 'cancelled')).toBe(false);
  });
});
