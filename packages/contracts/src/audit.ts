import { z } from '@sengoku/validation';

/**
 * 監査ログの閲覧の契約（管理画面・外部連携 指示書 §5）。
 *
 * ⚠️ **`summary` の中身は自由な形。** 操作ごとに残す項目が違うため、
 * 契約で固定すると新しい操作を足すたびに契約が壊れる。
 * ただし**出す前に伏せ字処理を通す**こと（`redactAuditSummary`）。
 */
export const auditLogEntrySchema = z.object({
  id: z.string(),
  /** `null` はシステムによる自動操作。 */
  actorAccountId: z.string().nullable(),
  /**
   * 操作した人の連絡先。
   *
   * ⚠️ **オーナー以外には `null` で返す。** スタッフ一覧を
   * オーナーだけに開いたのと同じ理由。
   */
  actorEmail: z.string().nullable(),
  action: z.string(),
  targetType: z.string(),
  targetId: z.string().nullable(),
  summary: z.record(z.string(), z.unknown()),
  occurredAt: z.string(),
});
export type AuditLogEntryView = z.infer<typeof auditLogEntrySchema>;

export const auditLogListResponseSchema = z.object({
  items: z.array(auditLogEntrySchema),
  nextCursor: z.string().nullable(),
  /**
   * 連絡先が伏せられているか。
   *
   * ⚠️ **画面に「伏せている」と書くために返す。** 何も言わずに伏せると、
   * 見た人は「記録されていない」と読む。記録はあるが見せていない、
   * という違いは監査では重い。
   */
  contactRedacted: z.boolean(),
});
export type AuditLogListResponse = z.infer<typeof auditLogListResponseSchema>;
