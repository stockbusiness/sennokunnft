import { z } from 'zod';

/**
 * ドメインイベントの封筒（EVENT_CATALOG.md §2）。
 *
 * 配信保証は **at-least-once**、順序は**保証しない**。
 * 購読側は `eventId` で重複排除し、順序に依存しない実装にすること。
 */
export const EVENT_NAMES = [
  'artwork.published',
  'artwork.archived',
  'listing.activated',
  'listing.closed',
  'order.created',
  'order.paid',
  'order.payment_failed',
  'order.expired',
  'order.refunded',
  'entitlement.issued',
  'entitlement.claimed',
  'entitlement.revoked',
  'mint.succeeded',
  'mint.failed',
] as const;
export type EventName = (typeof EVENT_NAMES)[number];

export const eventEnvelopeSchema = z.object({
  eventId: z.string().min(1),
  eventName: z.enum(EVENT_NAMES),
  eventVersion: z.number().int().min(1),
  occurredAt: z.iso.datetime(),
  aggregate: z.object({
    type: z.string().min(1),
    id: z.string().min(1),
  }),
  data: z.record(z.string(), z.unknown()),
});
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

const moneyShape = z.object({
  amount: z.number().int().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
});

/**
 * `order.paid` のデータ部。
 *
 * ⚠️ 購入者の氏名・メール・住所・カード情報を**含めない**。
 * イベントは複数の購読者・キュー・ログを経由するため、
 * そこに個人情報を載せると回収できない。
 * 必要な購読者は `accountId` を使って権限付き API で取得する。
 */
export const orderPaidDataSchema = z.object({
  orderId: z.string().min(1),
  accountId: z.string().min(1),
  total: moneyShape,
  paidAt: z.iso.datetime(),
  lines: z.array(
    z.object({
      artworkId: z.string().min(1),
      quantity: z.number().int().min(1),
      unitPrice: moneyShape,
    }),
  ),
});
export type OrderPaidData = z.infer<typeof orderPaidDataSchema>;

/**
 * `entitlement.issued` のデータ部。
 *
 * ⚠️ **Claim トークンを含めない。** Claim URL の生成は、
 * 通知チャネル側が権限付き API で都度取得する。
 */
export const entitlementIssuedDataSchema = z.object({
  entitlementId: z.string().min(1),
  orderId: z.string().min(1),
  accountId: z.string().min(1),
  artworkId: z.string().min(1),
  serialNo: z.number().int().min(1),
  expiresAt: z.iso.datetime().nullable(),
});
export type EntitlementIssuedData = z.infer<typeof entitlementIssuedDataSchema>;

export const entitlementClaimedDataSchema = z.object({
  entitlementId: z.string().min(1),
  accountId: z.string().min(1),
  claimedByAccountId: z.string().min(1),
  artworkId: z.string().min(1),
  serialNo: z.number().int().min(1),
  claimedAt: z.iso.datetime(),
});
export type EntitlementClaimedData = z.infer<typeof entitlementClaimedDataSchema>;

/**
 * `mint.succeeded` のデータ部。
 *
 * チェーン系の識別子は**不透明な文字列**として定義している。
 * 値の形式はチェーン選定（UD-501）まで確定できないため、
 * 購読側も形式に依存した処理を書いてはならない。
 */
export const mintSucceededDataSchema = z.object({
  entitlementId: z.string().min(1),
  mintJobId: z.string().min(1),
  chainRef: z.string().min(1),
  contractRef: z.string().min(1),
  tokenRef: z.string().min(1),
  txRef: z.string().nullable(),
  mintedAt: z.iso.datetime(),
});
export type MintSucceededData = z.infer<typeof mintSucceededDataSchema>;

/**
 * `mint.failed` のデータ部。
 *
 * `lastErrorCode` は**分類コードのみ**。外部 API の生のエラー本文は含めない
 * （秘匿値やエンドポイント情報が混入しうるため）。
 */
export const mintFailedDataSchema = z.object({
  entitlementId: z.string().min(1),
  mintJobId: z.string().min(1),
  attemptCount: z.number().int().min(0),
  lastErrorCode: z.string().min(1),
  failedAt: z.iso.datetime(),
});
export type MintFailedData = z.infer<typeof mintFailedDataSchema>;

/** イベント名とデータ部スキーマの対応。未知のイベントは購読側で無視させる。 */
export const EVENT_DATA_SCHEMAS = {
  'order.paid': orderPaidDataSchema,
  'entitlement.issued': entitlementIssuedDataSchema,
  'entitlement.claimed': entitlementClaimedDataSchema,
  'mint.succeeded': mintSucceededDataSchema,
  'mint.failed': mintFailedDataSchema,
} as const;
