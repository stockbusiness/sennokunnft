import { PAYMENT_CREDENTIAL_STATUSES } from '@sengoku/domain';
import { z } from '@sengoku/validation';

/**
 * 決済資格情報の世代（`UD-118`）。
 *
 * ⚠️ **鍵を載せない。** 値も、先頭も、末尾 4 文字も返さない
 * （2026-08-19 決定）。OVEW Wallet では末尾を出しているが、決済では出さない。
 * 判断が分かれているので取り違えないこと。
 *
 * ⚠️ **アカウント識別子（`acct_…`）は出す。** 秘密ではなく、
 * 「いまどの事業者アカウントへ入金されるか」を確かめる唯一の手掛かり。
 */

export const PAYMENT_CREDENTIAL_STATUS_VALUES = PAYMENT_CREDENTIAL_STATUSES;

export const paymentCredentialSchema = z.object({
  id: z.string(),
  generation: z.number().int(),
  status: z.enum(PAYMENT_CREDENTIAL_STATUS_VALUES),
  /** 決済事業者側のアカウント識別子。接続確認を通るまでは `null`。 */
  accountRef: z.string().nullable(),
  label: z.string().nullable(),
  apiVersion: z.string().nullable(),
  /** いま新規のお支払いを受け付けている世代か。 */
  acceptsNewPayments: z.boolean(),
  lastCheckSucceeded: z.boolean().nullable(),
  lastCheckAt: z.string().nullable(),
  lastWebhookReceivedAt: z.string().nullable(),
  activatedAt: z.string().nullable(),
  retiredAt: z.string().nullable(),
  createdAt: z.string(),
  /** この世代で処理した決済の件数。⚠️ 金額は出さない。 */
  paymentCount: z.number().int(),
  /** 署名検証の対象に残っているか（保持上限の内側か）。 */
  verifiable: z.boolean(),
});
export type PaymentCredentialView = z.infer<typeof paymentCredentialSchema>;

export const paymentCredentialListResponseSchema = z.object({
  environment: z.enum(['staging', 'production']),
  provider: z.string(),
  generations: z.array(paymentCredentialSchema),
  /**
   * いま販売できるか。
   *
   * ⚠️ **「有効な世代がある」ではない。** 新規受付の世代がちょうど 1 つ
   * あることを指す。0 なら販売が止まり、2 以上なら入金先が不定になる。
   */
  canAcceptPayments: z.boolean(),
  /**
   * 緊急上書きが有効か（`PAYMENT_EMERGENCY_CREDENTIAL_OVERRIDE`）。
   *
   * ⚠️ **有効なら画面の先頭に大きく出す。** 二重管理が黙って復活している
   * 状態なので、気づかないまま運用されるのがいちばん危ない。
   */
  emergencyOverrideActive: z.boolean(),
});
export type PaymentCredentialListResponse = z.infer<typeof paymentCredentialListResponseSchema>;

/**
 * 世代の登録。
 *
 * ⚠️ **平文を受け取るのはここだけ。** 預かったあとは二度と返さない。
 */
export const registerPaymentCredentialRequestSchema = z
  .object({
    /** ⚠️ 覚え書き。秘密を書かせない（画面の注記で伝える）。 */
    label: z.string().max(100).nullish(),
    apiVersion: z.string().max(50).nullish(),
    secretKey: z.string().min(1),
    webhookSecret: z.string().min(1),
  })
  .strict();
export type RegisterPaymentCredentialRequest = z.infer<
  typeof registerPaymentCredentialRequestSchema
>;

/**
 * 世代の有効化。
 *
 * ⚠️ **本番では確認入力を求める。** 「本当によろしいですか」の一段だけに
 * しない。押し慣れると意味を失う。
 */
export const activatePaymentCredentialRequestSchema = z
  .object({
    /** 本番のときだけ必須。`production` の文字をそのまま入力させる。 */
    confirmation: z.string().nullish(),
  })
  .strict();
export type ActivatePaymentCredentialRequest = z.infer<
  typeof activatePaymentCredentialRequestSchema
>;
