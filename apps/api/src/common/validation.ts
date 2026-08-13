import { BadRequestException } from '@nestjs/common';
import type { ApiError } from '@sengoku/contracts';
import { currentRequestId } from '@sengoku/observability';
import { validate, type z } from '@sengoku/validation';

/**
 * 入力をスキーマで検証する。
 *
 * ✅ 入力値はサーバー側で検証する。クライアント側の検証は UX のためのもので、
 * セキュリティ境界ではない。
 *
 * ⚠️ エラー応答に**入力値そのものを含めない**。
 * 反射させると、意図せず秘匿値を画面やログへ露出させることがある。
 */
export function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = validate(schema, input);
  if (result.ok) {
    return result.value;
  }

  const requestId = currentRequestId();
  const body: ApiError = {
    error: {
      code: 'VALIDATION_ERROR',
      message: '入力内容が正しくありません。',
      details: result.issues.map((issue) => ({ field: issue.field, issue: issue.issue })),
      ...(requestId === undefined ? {} : { requestId }),
    },
  };
  throw new BadRequestException(body);
}
