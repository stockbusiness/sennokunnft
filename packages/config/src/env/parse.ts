import type { ZodType } from 'zod';

/**
 * 環境変数の検証結果。
 *
 * 失敗時に「どの変数が」問題かは返すが、**値そのものは決して返さない**。
 * 起動ログは広く共有されるため、そこに秘密が載ることを避ける。
 * （SECURITY_DESIGN.md §3.3）
 */
export type EnvParseResult<T> =
  | { readonly ok: true; readonly env: T }
  | { readonly ok: false; readonly problems: readonly EnvProblem[] };

export interface EnvProblem {
  /** 環境変数名（例: `DATABASE_URL`）。 */
  readonly variable: string;
  /** 問題の種別。値は含まない。 */
  readonly issue: string;
}

/** 値の内容を露出させないよう、zod の issue を変数名と種別だけに落とす。 */
function toProblems(
  issues: readonly { path: PropertyKey[]; code: string; message: string }[],
): EnvProblem[] {
  return issues.map((issue) => ({
    variable: issue.path.length > 0 ? String(issue.path[0]) : '(unknown)',
    // message は zod が生成した定型文で、入力値を含まない code ベースの説明のみを使う。
    issue: issue.code === 'invalid_type' ? 'missing or wrong type' : issue.message,
  }));
}

/**
 * 環境変数を検証する。**プロセスを終了させない**ため、テストから安全に呼べる。
 *
 * 実際の起動時は {@link loadEnv} を使うこと。
 */
export function parseEnv<T>(schema: ZodType<T>, source: NodeJS.ProcessEnv): EnvParseResult<T> {
  const result = schema.safeParse(source);
  if (result.success) {
    return { ok: true, env: result.data };
  }
  return { ok: false, problems: toProblems(result.error.issues) };
}

/** 検証失敗時に標準エラーへ出す文言を組み立てる。値を含めない。 */
export function formatEnvProblems(problems: readonly EnvProblem[]): string {
  const lines = problems.map((p) => `  - ${p.variable}: ${p.issue}`);
  return ['環境変数の検証に失敗しました。以下を設定してください:', ...lines].join('\n');
}

export interface LoadEnvOptions {
  /** 終了処理。テストから差し替えられるようにしてある。 */
  readonly onFatal?: (message: string) => never;
}

function defaultOnFatal(message: string): never {
  process.stderr.write(`${message}\n`);
  // 不完全な設定のまま動かさない。安全側に倒して即座に終了する。
  process.exit(1);
}

/**
 * 環境変数を検証し、失敗したらプロセスを異常終了させる。
 *
 * 「起動はできたが一部機能が壊れている」状態を作らないため、
 * 部分的な成功を許さない設計にしている。
 */
export function loadEnv<T>(
  schema: ZodType<T>,
  source: NodeJS.ProcessEnv = process.env,
  options: LoadEnvOptions = {},
): T {
  const onFatal = options.onFatal ?? defaultOnFatal;
  const result = parseEnv(schema, source);
  if (!result.ok) {
    return onFatal(formatEnvProblems(result.problems));
  }
  return result.env;
}
