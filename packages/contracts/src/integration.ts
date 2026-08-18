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

export const INTEGRATION_SERVICE_VALUES = ['ovew_wallet', 'storage', 'auth'] as const;
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
  kind: z.enum(['reachability']),
  succeeded: z.boolean(),
  /** 失敗の分類。⚠️ 外部の生の応答は入れない。 */
  failureCode: z.string().nullable(),
  /** 相手が返した HTTP の状態コード。⚠️ 応答本文は返さない。 */
  httpStatus: z.number().int().nullable(),
  durationMs: z.number().int(),
  executedAt: z.string(),
});
export type ConnectionCheckView = z.infer<typeof connectionCheckSchema>;

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
   * 直近の接続確認の履歴。
   *
   * ⚠️ **成功だけを残さない。** 失敗も並べないと、
   * 「何度も失敗したあとの 1 回の成功」が見えなくなる。
   */
  recentChecks: z.array(connectionCheckSchema),
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
