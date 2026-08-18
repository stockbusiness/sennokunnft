import { z } from '@sengoku/validation';

/**
 * 送信の運用画面の契約（管理画面・外部連携 指示書 §5）。
 *
 * ⚠️ **本文（payload）の項目を作らない。** §5 は
 * 「Wallet へ送った本文全体を無条件で表示しない」と定めている。
 * 契約に項目が無ければ、実装側がうっかり載せても型で落ちる。
 *
 * ⚠️ **`Authorization` ヘッダー・API キー・HMAC 署名値の項目も作らない。**
 * 「調査に要る」と言われても、要るのは `eventId` と `correlationId` で、
 * その 2 つがあれば相手方と突き合わせられる。
 */

export const WALLET_DELIVERY_STATUS_VALUES = [
  'PENDING',
  'PROCESSING',
  'DELIVERED',
  'FAILED',
  'DEAD',
] as const;

export const walletDeliverySchema = z.object({
  id: z.string(),
  /** 相手の `Idempotency-Key` と同じ値。問い合わせのときはこれを伝える。 */
  eventId: z.string(),
  eventType: z.string(),
  entitlementId: z.string(),
  targetSiteKey: z.string(),
  /** `sha256:<hex>`。本文そのものは返さない。 */
  payloadHash: z.string(),
  status: z.enum(WALLET_DELIVERY_STATUS_VALUES),
  attemptCount: z.number().int(),
  maxAttempts: z.number().int(),
  nextRetryAt: z.string(),
  /** 失敗の分類コード（`timeout` / `http_503` など）。 */
  lastErrorCode: z.string().nullable(),
  lastErrorMessage: z.string().nullable(),
  correlationId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deliveredAt: z.string().nullable(),
  /**
   * いま手で送り直せるか。
   *
   * ⚠️ **これは保護ではない。** 画面のボタンを出し分けるための値で、
   * 実際に戻せるかどうかは API 側が状態を条件にした更新で判定する。
   */
  canResend: z.boolean(),
});
export type WalletDeliveryView = z.infer<typeof walletDeliverySchema>;

export const walletDeliveryListResponseSchema = z.object({
  items: z.array(walletDeliverySchema),
  /**
   * 状態ごとの全体件数。
   *
   * ⚠️ **絞り込みの影響を受けない値を返す。** 絞り込んだ結果の件数を出すと、
   * 「失敗 0 件」と書かれた画面が、実は失敗を除外した絞り込みの結果だった、
   * ということが起きる。
   */
  counts: z.record(z.enum(WALLET_DELIVERY_STATUS_VALUES), z.number().int()),
  /** 続きがあるときだけ入る。 */
  nextCursor: z.string().nullable(),
});
export type WalletDeliveryListResponse = z.infer<typeof walletDeliveryListResponseSchema>;

/**
 * 手で送り直す。
 *
 * ⚠️ **複数まとめて受け取るが、1 件ずつの結果を返す。** まとめて
 * 「成功しました」と返すと、戻せなかった行があっても押した人には分からない。
 */
export const resendWalletDeliveriesRequestSchema = z
  .object({
    ids: z.array(z.string()).min(1).max(50),
  })
  .strict();
export type ResendWalletDeliveriesRequest = z.infer<typeof resendWalletDeliveriesRequestSchema>;

export const walletDeliveryResendResultSchema = z.object({
  id: z.string(),
  outcome: z.enum(['requeued', 'not_found', 'not_resendable']),
});

export const resendWalletDeliveriesResponseSchema = z.object({
  results: z.array(walletDeliveryResendResultSchema),
});
export type ResendWalletDeliveriesResponse = z.infer<typeof resendWalletDeliveriesResponseSchema>;
