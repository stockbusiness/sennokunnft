import {
  NOTIFICATION_BODY_MAX,
  NOTIFICATION_EVENT_TYPES,
  NOTIFICATION_STATUSES,
  NOTIFICATION_SUBJECT_MAX,
  NOTIFICATION_SUBJECT_TYPES,
  NOTIFICATION_TEMPLATE_STATUSES,
} from '@sengoku/domain';
import { z } from 'zod';

/**
 * 購入者への知らせ（P0-4）の管理 API 契約。
 *
 * ⚠️ **宛先の平文を載せる項目を作らない**（`UD-503`）。出るのは
 * 伏せた表記だけ。項目そのものが無ければ、実装側がうっかり載せても
 * 型で落ちる。
 *
 * ⚠️ **本文（`renderedBody`）を一覧へ載せない。** 一覧に本文は要らない。
 * 要るのは「いつ・どの知らせを・送れたか」まで。
 */

export const NOTIFICATION_EVENT_TYPE_VALUES = NOTIFICATION_EVENT_TYPES;
export const NOTIFICATION_STATUS_VALUES = NOTIFICATION_STATUSES;

/** 文面の 1 版。 */
export const notificationTemplateSchema = z.object({
  eventType: z.enum(NOTIFICATION_EVENT_TYPES),
  version: z.number().int().positive(),
  subject: z.string(),
  body: z.string(),
  status: z.enum(NOTIFICATION_TEMPLATE_STATUSES),
  publishedAt: z.string().nullable(),
  updatedAt: z.string(),
});
export type NotificationTemplateView = z.infer<typeof notificationTemplateSchema>;

export const notificationTemplateListResponseSchema = z.object({
  items: z.array(notificationTemplateSchema),
  /**
   * 種別ごとに差し込める語。
   *
   * ⚠️ **画面へ渡す。** 渡さないと、書く人は語彙を知らないまま書き、
   * 公開の段になって初めて弾かれる。書きながら気づけるようにする。
   */
  variables: z.record(z.enum(NOTIFICATION_EVENT_TYPES), z.array(z.string())),
});
export type NotificationTemplateListResponse = z.infer<
  typeof notificationTemplateListResponseSchema
>;

/** 新しい版を作るときの入力。⚠️ 既存の版は書き換えない。 */
export const createNotificationTemplateRequestSchema = z.object({
  subject: z.string().trim().min(1).max(NOTIFICATION_SUBJECT_MAX),
  body: z.string().trim().min(1).max(NOTIFICATION_BODY_MAX),
  /**
   * 下書きのまま置くか、すぐ公開するか。
   *
   * ⚠️ **既定を下書きにする。** 「保存」を押しただけで全員へ届く文面が
   * 変わるのは、書いている側の予想を超える。
   */
  publish: z.boolean().default(false),
});
export type CreateNotificationTemplateRequest = z.infer<
  typeof createNotificationTemplateRequestSchema
>;

/** 送信履歴の 1 行。⚠️ 宛先は伏せた表記だけ。 */
export const notificationHistorySchema = z.object({
  id: z.string(),
  eventType: z.enum(NOTIFICATION_EVENT_TYPES),
  subjectType: z.enum(NOTIFICATION_SUBJECT_TYPES),
  subjectId: z.string(),
  /** `t*****@e******.jp`。⚠️ **ここから元へは戻せない。** */
  maskedRecipient: z.string().nullable(),
  templateVersion: z.number().int().positive(),
  subject: z.string(),
  status: z.enum(NOTIFICATION_STATUSES),
  attemptCount: z.number().int().nonnegative(),
  lastErrorCode: z.string().nullable(),
  skippedReasonCode: z.string().nullable(),
  sentAt: z.string().nullable(),
  createdAt: z.string(),
});
export type NotificationHistoryView = z.infer<typeof notificationHistorySchema>;

export const notificationHistoryListResponseSchema = z.object({
  items: z.array(notificationHistorySchema),
  nextCursor: z.string().nullable(),
});
export type NotificationHistoryListResponse = z.infer<typeof notificationHistoryListResponseSchema>;

export const notificationHistoryQuerySchema = z.object({
  status: z.enum(NOTIFICATION_STATUSES).optional(),
  eventType: z.enum(NOTIFICATION_EVENT_TYPES).optional(),
  subjectId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});
export type NotificationHistoryQuery = z.infer<typeof notificationHistoryQuerySchema>;

/** 送信ジョブ 1 巡の結果。⚠️ 人の情報を混ぜない（時計が叩く口の応答）。 */
export const sendNotificationsResponseSchema = z.object({
  pickedCount: z.number().int().nonnegative(),
  sentCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
});
export type SendNotificationsResponse = z.infer<typeof sendNotificationsResponseSchema>;
