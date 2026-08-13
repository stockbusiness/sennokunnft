/**
 * ドメイン層の戻り値表現。
 *
 * 例外ではなく型付きの Result を返す理由:
 * 「在庫切れ」「Claim 済み」は異常事態ではなく**正常な業務結果**であり、
 * 呼び出し側に網羅的な分岐を型で強制したいため。
 * （DOMAIN_MODEL.md §7）
 *
 * 例外は「バグまたは復旧不能な障害」にのみ使う。
 */
export type Result<T, E> = Ok<T> | Err<E>;

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

/** Ok を期待する箇所で使う。Err ならバグなので例外を投げる。 */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) {
    return result.value;
  }
  throw new Error(`unwrap() called on Err: ${JSON.stringify(result.error)}`);
}
