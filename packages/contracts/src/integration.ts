import { CONNECTION_CHECK_KINDS, INTEGRATION_SERVICES } from '@sengoku/domain';
import { z } from '@sengoku/validation';

/**
 * 外部連携の設定（管理画面・外部連携 指示書 §12）。
 *
 * ⚠️ **サービスごとに項目を固定する。** 未知の設定名は拒否する。
 * 自由入力にすると、綴り違いの設定名が黙って保存され、どれが効いて
 * いるのか分からなくなる。
 *
 * ⚠️ **秘密をこの形に載せない。** 応答に含めてよいのは
 * 「設定されているか」「末尾 4 文字」「いつ更新したか」まで。
 */

/*
  ⚠️ **ドメインから引く。書き写さない。** 以前ここに同じ配列を書いていて、
     決済を足したときに片方だけ増えた。契約の側が古いと、正しい値を
     送っても「そんなサービスは無い」と断られる。
*/
export const INTEGRATION_SERVICE_VALUES = INTEGRATION_SERVICES;
export const INTEGRATION_ENVIRONMENT_VALUES = ['staging', 'production'] as const;
export const SECRET_PURPOSE_VALUES = ['api_key', 'hmac_secret'] as const;

/** 資格情報の状態。**平文も暗号文も含まない。** */
export const integrationSecretSchema = z.object({
  id: z.string(),
  purpose: z.enum(SECRET_PURPOSE_VALUES),
  status: z.enum(['pending', 'active', 'retired']),
  /** 見分け用。⚠️ 4 文字を超えない。 */
  lastFour: z.string().max(4),
  keyVersion: z.string(),
  activatedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type IntegrationSecretView = z.infer<typeof integrationSecretSchema>;

export const connectionCheckSchema = z.object({
  id: z.string(),
  /**
   * 何を確かめたか。
   *
   * ⚠️ **「成功」だけでは足りない。** `reachability` は接続先へ届くことを
   * 確かめただけで、資格情報が正しいかどうかは確かめていない（要決定 06）。
   * 画面には必ず、何を確かめていないかを併記すること。
   */
  kind: z.enum(CONNECTION_CHECK_KINDS),
  succeeded: z.boolean(),
  /** 失敗の分類。⚠️ 外部の生の応答は入れない。 */
  failureCode: z.string().nullable(),
  /** 相手が返した HTTP の状態コード。⚠️ 応答本文は返さない。 */
  httpStatus: z.number().int().nullable(),
  durationMs: z.number().int(),
  executedAt: z.string(),
});
export type ConnectionCheckView = z.infer<typeof connectionCheckSchema>;

/**
 * 配備環境から読める、その連携の姿。
 *
 * ⚠️ **値を持たない。** 持つのは方式と、欠けている設定の**名前**まで。
 * 名前は秘密ではなく、直すために要る。値は秘密でありうる。
 */
export const environmentSummarySchema = z.object({
  provider: z.string(),
  complete: z.boolean(),
  missing: z.array(z.string()),
  publicUrl: z.string().nullable(),
});
export type EnvironmentSummaryView = z.infer<typeof environmentSummarySchema>;

/**
 * 決済の設定（管理画面から変える分）。
 *
 * ⚠️ **秘密を含めない。** 秘密鍵も署名鍵もここには入らない。
 */
export const paymentSettingsSchema = z.object({
  apiVersion: z.string().nullable(),
  /** ⚠️ `{ORDER_ID}` を含む。含まないものは保存の口が断る。 */
  checkoutSuccessUrl: z.string().nullable(),
  checkoutCancelUrl: z.string().nullable(),
  /**
   * プラットフォーム手数料（ベーシスポイント）。
   *
   * ⚠️ **0 は「無料」ではなく「販売設定が未完了」。** 画面はこの値を
   * そのまま「手数料 0%」と書かないこと。
   */
  platformFeeRateBps: z.number().int(),
  /** 率が入っているか。⚠️ 画面が 0 を「無料」と読まないための印。 */
  salesSetupComplete: z.boolean(),
  /** 鍵以外の設定を、どちらから読んでいるか。⚠️ 鍵の出どころではない。 */
  settingsSource: z.enum(['database', 'environment']),
  /*
    ここから下は配備環境の状態。
    ⚠️ **鍵そのもの・先頭・末尾・署名値をここへ入れない**（2026-08-19 決定）。
       入るのは「設定されているか」「どちらのモードか」まで。
  */
  secretKeyConfigured: z.boolean(),
  webhookSecretConfigured: z.boolean(),
  /**
   * テストか本番か。
   *
   * ⚠️ **鍵の値は出さない。** 取り違えに気づけるだけの粒度に留める。
   */
  mode: z.enum(['test', 'live', 'unknown']),
  /** 最後に知らせが届いた時刻。⚠️ 本文も署名も返さない。 */
  lastWebhookReceivedAt: z.string().nullable(),
});
export type PaymentSettingsView = z.infer<typeof paymentSettingsSchema>;

export const integrationStatusSchema = z.object({
  service: z.enum(INTEGRATION_SERVICE_VALUES),
  environment: z.enum(INTEGRATION_ENVIRONMENT_VALUES),
  endpointUrl: z.string().nullable(),
  /**
   * 署名に使う鍵の識別子。
   *
   * ⚠️ **これは秘密ではない。** 署名ヘッダにそのまま載る名前なので、
   * 伏せずに返す。伏せると、取り違えたときに画面から確かめられない。
   */
  keyId: z.string().nullable(),
  apiVersion: z.string().nullable(),
  timeoutMs: z.number().int(),
  maxAttempts: z.number().int(),
  enabled: z.boolean(),
  /** 楽観ロック用。書き戻しでそのまま返す。 */
  rowVersion: z.number().int(),
  /**
   * ⚠️ **「保存できたか」と「繋がるか」を分けて持つ。**
   * 1 つにまとめると「保存できたから繋がっている」と読まれる。
   */
  secrets: z.array(integrationSecretSchema),
  lastCheck: connectionCheckSchema.nullable(),
  /** 直近の接続テストが、いま有効とみなせるか。 */
  checkFresh: z.boolean(),
  /** いま有効化できるか。できない理由は画面が状態から組み立てる。 */
  canEnable: z.boolean(),
  /** いま接続確認を行えるか（接続先が入っているか）。 */
  canCheck: z.boolean(),
  /**
   * この画面から設定を変えられるか。
   *
   * ⚠️ **偽のときは、保存の口そのものが断る。** 画面で隠すだけにすると、
   * 直接叩けば「誰も読まない設定」が保存できてしまう。
   */
  manageable: z.boolean(),
  /**
   * 配備環境（環境変数）から読める姿。管理外の連携ではこちらが正。
   *
   * ⚠️ **管理できる連携では `null`。** 2 つの正を並べない。
   */
  environmentSummary: environmentSummarySchema.nullable(),
  /**
   * 直近の接続確認の履歴。
   *
   * ⚠️ **成功だけを残さない。** 失敗も並べないと、
   * 「何度も失敗したあとの 1 回の成功」が見えなくなる。
   */
  recentChecks: z.array(connectionCheckSchema),
  /**
   * 決済にだけある欄。ほかの連携では `null`。
   *
   * ⚠️ **鍵はここに入らない。** 入るのは戻り先と手数料率まで。
   * 秘密は `secrets` に、末尾 4 文字と状態だけが出る。
   */
  payment: paymentSettingsSchema.nullable(),
});
export type IntegrationStatusView = z.infer<typeof integrationStatusSchema>;

export const integrationListResponseSchema = z.object({
  /** このプロセスがどの環境か。⚠️ 設定の `environment` とは別物。 */
  appEnvironment: z.enum(INTEGRATION_ENVIRONMENT_VALUES),
  items: z.array(integrationStatusSchema),
});
export type IntegrationListResponse = z.infer<typeof integrationListResponseSchema>;

/**
 * 設定の更新。
 *
 * ⚠️ **秘密を受け取らない。** 資格情報は別の経路（`/secrets`）で扱う。
 * 同じ本文で受けると、うっかりログや監査ログへ載る経路が増える。
 */
export const updateIntegrationRequestSchema = z
  .object({
    endpointUrl: z.string().trim().max(2048).nullable().optional(),
    keyId: z.string().trim().max(128).nullable().optional(),
    apiVersion: z.string().trim().max(64).nullable().optional(),
    timeoutMs: z.number().int().optional(),
    maxAttempts: z.number().int().optional(),
    /**
     * 決済にだけ意味のある欄。ほかの連携へ送っても無視される。
     *
     * ⚠️ **秘密はここに入らない。** 鍵は `/secrets` の経路で扱う。
     */
    checkoutSuccessUrl: z.string().trim().max(2048).nullable().optional(),
    checkoutCancelUrl: z.string().trim().max(2048).nullable().optional(),
    /** ⚠️ 0 は「無料」ではなく「販売設定が未完了」。 */
    platformFeeRateBps: z.number().int().min(0).max(10_000).optional(),
    /** 読んだときの版。一致しなければ拒否する。 */
    rowVersion: z.number().int(),
  })
  .strict();
export type UpdateIntegrationRequest = z.infer<typeof updateIntegrationRequestSchema>;

/**
 * 資格情報の登録。
 *
 * ⚠️ **この形の値を、どこにも記録しない。** 監査ログにもエラーにも
 * ログにも出さない。残るのは末尾 4 文字だけ。
 */
export const registerSecretRequestSchema = z
  .object({
    purpose: z.enum(SECRET_PURPOSE_VALUES),
    // ⚠️ 長さだけを縛る。中身の形は外部サービスが決めるもので、
    //    こちらで決めると実在する資格情報が弾かれる。
    value: z.string().min(8).max(4096),
  })
  .strict();
export type RegisterSecretRequest = z.infer<typeof registerSecretRequestSchema>;
