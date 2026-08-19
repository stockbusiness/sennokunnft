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

import type { AuditLogPage, AuditLogQuery } from '../audit/read';

/** 現在時刻。テストで固定できるようにポート化する。 */
export interface ClockPort {
  now(): Date;
}

/** 識別子の生成。`Math.random()` を使わない実装であること。 */
export interface IdGeneratorPort {
  generate(): string;
}

/**
 * 予測されては困る値のもと。
 *
 * ⚠️ **`Math.random()` で実装しない。** 出力から内部状態を復元できる。
 * 注文番号のように「他人のものを当てられては困る」値に使う。
 */
export interface RandomPort {
  /** 暗号論的に安全な乱数を `length` バイト返す。 */
  bytes(length: number): Uint8Array;
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

/*
  決済ゲートウェイの境界は `./payment.ts` へ移した（決済 Phase P2）。

  ⚠️ **ここにあった Phase 1 の下書きは消してある。** 決済事業者が
  未決（`UD-702`）だったころの形で、成功・失敗の区別も、金額の照合も
  持っていなかった。2 つ並べておくと、新しく書く人がどちらを実装すべきか
  分からず、古いほうを実装して「署名は通るのに注文が進まない」になる。
  境界は 1 つだけにする。
*/

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

export interface StoredObject {
  /** ストレージ上のキー。**公開URLではない。** */
  readonly key: string;
  readonly contentType: string;
  readonly byteSize: number;
}

export interface PutObjectInput {
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

/**
 * 画像などのオブジェクト保存。
 *
 * ⚠️ **保存するのは公開URLではなくキー。**
 * URL を保存すると、保存先を変えたときに過去のレコードが全部壊れる。
 * 公開URLは実行時にキーから解決する。
 *
 * 保存先は未決定（`UD-508`）。Phase 2 ではローカル/Fake 実装のみを用意し、
 * S3・Supabase Storage・IPFS への接続は行わない。
 */
export interface StoragePort {
  put(input: PutObjectInput): Promise<StoredObject>;
  /** 置換・削除時に使う。存在しないキーでも例外にしない（冪等）。 */
  remove(key: string): Promise<void>;
  /** 表示用のURLを解決する。実装によって署名付きURLにもできる。 */
  publicUrl(key: string): string;
}

export interface AuditEntry {
  /** システムによる自動操作なら `null`。 */
  readonly actorAccountId: string | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string | null;
  /**
   * 何が起きたかの要約。
   *
   * ⚠️ **秘匿値・個人情報・入力値そのものを入れない。**
   * 監査ログは長期に残り、閲覧範囲も広い。追跡に要る最小限に留める。
   */
  readonly summary: Record<string, unknown>;
}

/** 運営操作の証跡。 */
export interface AuditLogPort {
  record(entry: AuditEntry): Promise<void>;
}

/**
 * 証跡を読む口。
 *
 * ⚠️ **書く口と分けてある。** 記録は業務処理のあちこちから呼ばれるが、
 * 読み出しは管理画面だけが使う。ひとつの interface にすると、
 * 記録したいだけの箇所が一覧の実装まで抱えることになる。
 */
export interface AuditLogReadPort {
  list(query: AuditLogQuery): Promise<AuditLogPage>;
}
