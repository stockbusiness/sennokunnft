import { z } from 'zod';

/**
 * ヘルスチェックの応答契約（API_DESIGN.md §4.1）。
 *
 * liveness と readiness を分けているのは、DB 障害で liveness まで失敗させると
 * コンテナが再起動を繰り返し、復旧を妨げるため。
 *
 * ⚠️ 応答に接続文字列・ホスト名・依存サービスの詳細を含めない。
 * ヘルスチェックは認証なしで到達できるため、内部構成の偵察に使われうる。
 */
export const livenessResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.string().min(1),
  version: z.string().min(1),
  uptimeSec: z.number().nonnegative(),
});
export type LivenessResponse = z.infer<typeof livenessResponseSchema>;

export const READINESS_STATUSES = ['ok', 'degraded'] as const;

export const readinessCheckSchema = z.object({
  /** 依存の論理名（`database` など）。接続先そのものは出さない。 */
  name: z.string().min(1),
  status: z.enum(['pass', 'fail']),
  durationMs: z.number().nonnegative(),
});
export type ReadinessCheck = z.infer<typeof readinessCheckSchema>;

export const readinessResponseSchema = z.object({
  status: z.enum(READINESS_STATUSES),
  service: z.string().min(1),
  checks: z.array(readinessCheckSchema),
});
export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;
