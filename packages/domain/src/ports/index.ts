/**
 * ドメインが外部に要求する境界（ポート）。
 *
 * ここには **interface のみ**を置き、実装を持たない。
 * 実装（アダプタ）は `@sengoku/database` と `@sengoku/integrations` にある。
 *
 * ブロックチェーン関連の識別子をすべて不透明な文字列にしているのは、
 * チェーン仕様が未決定（UD-501）だからである。
 * EVM のアドレス形式などを型で固定すると、決定前に選択肢を狭めてしまう。
 */

/** 現在時刻。テストで固定できるようにポート化する。 */
export interface ClockPort {
  now(): Date;
}

/** 識別子の生成。`Math.random()` を使わない実装であること。 */
export interface IdGeneratorPort {
  generate(): string;
}

export interface IssuedClaimToken {
  /** 利用者に渡す平文。**保存・ログ出力してはならない。** */
  readonly token: string;
  /** DB に保存するハッシュ。 */
  readonly tokenHash: string;
}

/**
 * Claim トークンの発行と照合。
 *
 * 平文をDBに残さないことで、DB が漏洩しても Claim されないようにする
 * （SECURITY_DESIGN.md §8）。
 */
export interface ClaimTokenPort {
  issue(): IssuedClaimToken;
  hash(token: string): string;
  /** タイミング安全な比較を行う実装であること。 */
  matches(token: string, expectedHash: string): boolean;
}

/** 発行ジョブの冪等キーを、受取権IDから決定論的に導出する。 */
export interface IdempotencyKeyPort {
  deriveMintKey(entitlementId: string): string;
}

export interface CheckoutSessionRequest {
  readonly orderId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
}

export interface CheckoutSession {
  readonly providerSessionRef: string;
  readonly redirectUrl: string;
}

export interface WebhookVerificationInput {
  /** 署名検証には**パース前の生の本文**が必要。 */
  readonly rawBody: Buffer;
  readonly signatureHeader: string | undefined;
  readonly receivedAt: Date;
}

export interface VerifiedWebhook {
  readonly eventId: string;
  readonly eventType: string;
  readonly payload: unknown;
}

/**
 * 決済ゲートウェイ。
 *
 * 決済事業者は未決定（UD-702）。Phase 1 では Fake 実装のみを用意する。
 */
export interface PaymentGatewayPort {
  readonly provider: string;
  createCheckoutSession(request: CheckoutSessionRequest): Promise<CheckoutSession>;
  /** 署名検証。失敗したら例外ではなく `null` を返し、呼び出し側が 400 を返す。 */
  verifyWebhook(input: WebhookVerificationInput): VerifiedWebhook | null;
}

export interface MintRequest {
  readonly entitlementId: string;
  /** 再試行しても変わらないキー。外部側の重複排除に使う。 */
  readonly idempotencyKey: string;
  /** メタデータの所在。形式はチェーン非依存の不透明参照。 */
  readonly metadataRef: string;
  /** 受取先。カストディ方式が未決定（UD-502）のため不透明参照。 */
  readonly recipientRef: string;
}

export type MintState = 'accepted' | 'pending' | 'succeeded' | 'failed';

export interface MintSubmission {
  /** プロバイダ側の依頼識別子。状態問い合わせに使う。 */
  readonly submissionRef: string;
  readonly state: MintState;
}

export interface MintStatus {
  readonly state: MintState;
  readonly chainRef?: string;
  readonly contractRef?: string;
  readonly tokenRef?: string;
  readonly txRef?: string;
  /** 失敗理由の**分類コード**。外部APIの生メッセージを載せない。 */
  readonly errorCode?: string;
}

/**
 * トークン発行。
 *
 * `submit` と `getStatus` の 2 つを持つのは、完了通知がコールバック方式か
 * ポーリング方式か未決定（UD-703）で、どちらでも動くようにするため。
 */
export interface MintingPort {
  readonly provider: string;
  submit(request: MintRequest): Promise<MintSubmission>;
  getStatus(submissionRef: string): Promise<MintStatus>;
}

export interface StoredMetadata {
  readonly ref: string;
  readonly uri: string;
}

/**
 * メタデータ・画像の保存。
 *
 * 保存先は未決定（UD-508）。
 * **個人情報をメタデータに含めてはならない**（公開される前提のため）。
 */
export interface MetadataStoragePort {
  store(key: string, content: unknown): Promise<StoredMetadata>;
}

export interface DomainEventRecord {
  readonly eventName: string;
  readonly eventVersion: number;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: Record<string, unknown>;
  readonly occurredAt: Date;
}

/**
 * ドメインイベントの発行。
 *
 * 業務データの更新と**同一トランザクション**で書けること（Transactional Outbox）。
 * 「支払は確定したが通知が飛ばなかった」を構造的に防ぐ。
 */
export interface EventPublisherPort {
  publish(event: DomainEventRecord): Promise<void>;
}
