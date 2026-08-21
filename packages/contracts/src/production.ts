import { ATTESTATION_KINDS, PRODUCTION_READINESS_CHECKS } from '@sengoku/domain';
import { z } from 'zod';

/**
 * 本番販売ガード（P0-7）の契約。
 *
 * ⚠️ **秘密を返す項目を作らない。** 鍵の値も署名鍵も、有無と確認の結果
 * しか要らない。項目そのものが無ければ、実装側がうっかり載せても型で落ちる。
 */

export const productionReadinessCheckSchema = z.object({
  key: z.enum(PRODUCTION_READINESS_CHECKS),
  label: z.string(),
  satisfied: z.boolean(),
  /** いまの状態。⚠️ 秘密を書かない。 */
  detail: z.string(),
  /** 何をすればよいか。⚠️ 満たしていても出す（あとで崩れたときのため）。 */
  remedy: z.string(),
});
export type ProductionReadinessCheckView = z.infer<typeof productionReadinessCheckSchema>;

export const productionReadinessResponseSchema = z.object({
  /** ⚠️ **10 個すべて満たしたときだけ真。** */
  ready: z.boolean(),
  /**
   * この判定が本番の支払い口を止めるか。
   *
   * ⚠️ **`ready` と分けてある。** staging では判定はするが止めない。
   * 止めると誰も試せず、本番で初めて動かすことになる。
   */
  enforced: z.boolean(),
  environment: z.string(),
  checks: z.array(productionReadinessCheckSchema),
  /** いま紐づいている決済世代。⚠️ 識別子まで。鍵は返さない。 */
  credentialId: z.string().nullable(),
  generatedAt: z.string(),
});
export type ProductionReadinessResponse = z.infer<typeof productionReadinessResponseSchema>;

export const attestationSchema = z.object({
  id: z.string(),
  kind: z.enum(ATTESTATION_KINDS),
  succeeded: z.boolean(),
  credentialId: z.string(),
  attestedByAccountId: z.string(),
  note: z.string().nullable(),
  attestedAt: z.string(),
});
export type AttestationView = z.infer<typeof attestationSchema>;

export const attestationListResponseSchema = z.object({
  items: z.array(attestationSchema),
});
export type AttestationListResponse = z.infer<typeof attestationListResponseSchema>;

/**
 * 証跡を残す。
 *
 * ⚠️ **`credentialId` を受け取らない。** 受け取れると、いま受付中で
 * ない世代を指す証跡を作れてしまう。サーバー側でいまの世代へ紐づける。
 */
export const recordAttestationRequestSchema = z.object({
  kind: z.enum(ATTESTATION_KINDS),
  succeeded: z.boolean(),
  /** ⚠️ **秘密を書かせない。** 画面にも注意書きを出す。 */
  note: z.string().max(1000).nullable().default(null),
});
export type RecordAttestationRequest = z.infer<typeof recordAttestationRequestSchema>;

/** メールの試し送りの結果。⚠️ 宛先は伏せた形しか返さない。 */
export const mailCheckResponseSchema = z.object({
  succeeded: z.boolean(),
  /** `t*****@e******.jp`。⚠️ **平文を返さない。** */
  maskedRecipient: z.string().nullable(),
  failureCode: z.string().nullable(),
  executedAt: z.string(),
});
export type MailCheckResponse = z.infer<typeof mailCheckResponseSchema>;
