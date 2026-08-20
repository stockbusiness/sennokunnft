import { describe, expect, it } from 'vitest';
import {
  ENTITLEMENT_STATUSES,
  MINT_JOB_STATUSES,
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

/*
  注文の状態遷移は `tests/order-status.test.ts` へ移した。
  1 本の列から 4 本（注文・決済・付与・返金）へ分けたため。
*/

describe('受取権の状態遷移', () => {
  it('全組み合わせが遷移表どおりに判定される', () => {
    assertExhaustiveTransitions(entitlementStateMachine, ENTITLEMENT_STATUSES);
  });

  it('claimed から進めるのは revoked だけ（`UD-104` 追補）', () => {
    /*
      ⚠️ **`issued` / `expired` へは戻さない。** 戻せるようにすると、
         「いま有効か」を状態列だけでは答えられなくなる。
      全額返金で権利を失わせても、受け取った記録そのものは消さない。
    */
    for (const to of ENTITLEMENT_STATUSES) {
      expect(entitlementStateMachine.canTransition('claimed', to)).toBe(to === 'revoked');
    }
  });

  it('revoked は終端で、どの状態へも戻らない', () => {
    // 再付与は、この行を戻すのではなく新しい受取権を作ることで行う。
    expect(entitlementStateMachine.isTerminal('revoked')).toBe(true);
    for (const to of ENTITLEMENT_STATUSES) {
      expect(entitlementStateMachine.canTransition('revoked', to)).toBe(false);
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
