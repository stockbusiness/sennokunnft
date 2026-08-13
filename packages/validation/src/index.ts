/**
 * `@sengoku/validation` — 入力値検証の共通部品。
 *
 * 責務:
 *  - 何度も使う小さなスキーマ（ID・金額・数量・ページング）を一箇所に定義する
 *  - 検証失敗を、値を漏らさない形に整形する
 *
 * 責務ではないもの:
 *  - 業務規則（`@sengoku/domain` の担当）。「在庫があるか」はここでは判定しない
 *  - HTTP の知識（`apps/api` の担当）
 *
 * クライアント側でも同じスキーマを使えるが、**サーバー側の検証を省略してはならない**。
 * クライアント検証は UX のためのものであり、セキュリティ境界ではない。
 */
import { z } from 'zod';

/** 内部識別子。UUID を採用している（DATABASE_DESIGN.md §1）。 */
export const idSchema = z.uuid();

/** 最小通貨単位の金額。整数のみ（NFR-01）。 */
export const amountMinorSchema = z
  .number()
  .int('金額は整数でなければなりません')
  .nonnegative('金額は 0 以上でなければなりません')
  .refine((value) => Number.isSafeInteger(value), '金額が扱える範囲を超えています');

/** ISO 4217 の通貨コード。 */
export const currencySchema = z.string().regex(/^[A-Z]{3}$/, '通貨コードの形式が正しくありません');

export const moneySchema = z.object({
  amount: amountMinorSchema,
  currency: currencySchema,
});
export type MoneyInput = z.infer<typeof moneySchema>;

/** 注文数量。上限の最終判定はドメイン層が行う。 */
export const quantitySchema = z.number().int().min(1).max(100);

/** URL などに使う slug。 */
export const slugSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug は英小文字・数字・ハイフンのみ使用できます');

/** ISO 8601 の日時文字列。 */
export const isoDateTimeSchema = z.iso.datetime();

/**
 * カーソルページング。
 *
 * オフセットではなくカーソルにしているのは、
 * 件数が増減しても取りこぼし・重複が起きないようにするため。
 */
export const paginationSchema = z.object({
  cursor: z.string().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(100).default(20),
});
export type PaginationInput = z.infer<typeof paginationSchema>;

/**
 * 冪等キー。
 *
 * 状態を変える POST では必須（API_DESIGN.md §3）。
 */
export const idempotencyKeySchema = z.string().min(8).max(128);

export interface FieldIssue {
  readonly field: string;
  /** 問題の種別。**入力値そのものを含めない。** */
  readonly issue: string;
}

/**
 * zod の検証結果を、値を漏らさない形の一覧に変換する。
 *
 * エラー応答に入力値をそのまま反射させると、
 * 意図せず秘匿値をログや画面へ露出させることがある。
 */
export function toFieldIssues(error: z.ZodError): FieldIssue[] {
  return error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join('.') : '(root)',
    issue: issue.code,
  }));
}

export type ValidationOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly FieldIssue[] };

/** スキーマで検証し、失敗時は値を含まない問題一覧を返す。 */
export function validate<T>(schema: z.ZodType<T>, input: unknown): ValidationOutcome<T> {
  const result = schema.safeParse(input);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  return { ok: false, issues: toFieldIssues(result.error) };
}

export { z };
