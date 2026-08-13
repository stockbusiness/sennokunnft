import { domainError, type DomainError } from '../shared/errors';
import { err, ok, type Result } from '../shared/result';

/**
 * 状態遷移表から遷移関数を組み立てる。
 *
 * 遷移を「表」として1箇所に書くことで、
 *  - 許可された遷移
 *  - 許可されていない遷移
 * の両方をテストで機械的に網羅できる（TEST_STRATEGY.md §3.5 T-1/T-2）。
 *
 * if 文で遷移を書くと、状態が増えたときに分岐の追加漏れが起きる。
 */
export type TransitionTable<S extends string> = {
  readonly [From in S]: readonly S[];
};

export interface StateMachine<S extends string> {
  /** 遷移が許可されているか。 */
  canTransition(from: S, to: S): boolean;
  /** 遷移を試みる。許可されていなければ `INVALID_STATE_TRANSITION`。 */
  transition(from: S, to: S): Result<S, DomainError>;
  /** その状態からどこへも遷移できない（終端状態）か。 */
  isTerminal(state: S): boolean;
  /** 定義されている全状態。 */
  readonly states: readonly S[];
  readonly table: TransitionTable<S>;
}

export function createStateMachine<S extends string>(table: TransitionTable<S>): StateMachine<S> {
  const states = Object.keys(table) as S[];

  function canTransition(from: S, to: S): boolean {
    const allowed: readonly S[] | undefined = table[from];
    return allowed !== undefined && allowed.includes(to);
  }

  return {
    states,
    table,
    canTransition,
    transition(from: S, to: S): Result<S, DomainError> {
      if (!canTransition(from, to)) {
        // detail に状態名は含めてよい（秘匿値ではない）。
        return err(domainError('INVALID_STATE_TRANSITION', `${from} -> ${to} is not allowed`));
      }
      return ok(to);
    },
    isTerminal(state: S): boolean {
      const allowed: readonly S[] | undefined = table[state];
      return allowed === undefined || allowed.length === 0;
    },
  };
}
