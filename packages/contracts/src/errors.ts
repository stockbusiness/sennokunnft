import { z } from 'zod';

/**
 * API エラー応答の統一形式（API_DESIGN.md §2）。
 *
 * `code` を安定した機械可読値にしているのは、
 * HTTP ステータスだけでは「なぜ 409 なのか」を呼び出し側が判別できないため。
 */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    details: z.array(z.object({ field: z.string(), issue: z.string() })).optional(),
    requestId: z.string().optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

/** ドメイン層に対応しない、境界で発生するエラーのコード。 */
export const TRANSPORT_ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
] as const;
export type TransportErrorCode = (typeof TRANSPORT_ERROR_CODES)[number];
