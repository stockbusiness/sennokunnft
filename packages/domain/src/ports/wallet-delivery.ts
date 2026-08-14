import type {
  DeliveryAttemptOutcome,
  WalletDeliveryOutboxStatus,
} from '../wallet-delivery/dispatch';
import type { WalletDeliveryEventType } from '../wallet-delivery/event';

/** 配送待ち行列の 1 行。送信に必要なものだけを持つ。 */
export interface WalletDeliveryRecord {
  readonly id: string;
  /** 相手の `Idempotency-Key` と同じ値。**再試行でも作り直さない。** */
  readonly eventId: string;
  readonly eventType: WalletDeliveryEventType;
  readonly entitlementId: string;
  readonly targetSiteKey: string;
  /** 送信する本文の JSON テキストそのもの。署名対象と一致する。 */
  readonly payload: string;
  readonly payloadHash: string;
  readonly status: WalletDeliveryOutboxStatus;
  /** これまでに試した回数（`claimBatch` で加算済みの値）。 */
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly correlationId: string;
}

/** 行を作るときの入力。業務状態の変更と同一トランザクションで呼ぶ。 */
export interface WalletDeliveryEnqueueInput {
  readonly eventId: string;
  readonly eventType: WalletDeliveryEventType;
  readonly entitlementId: string;
  readonly targetSiteKey: string;
  readonly payload: string;
  readonly payloadHash: string;
  readonly correlationId: string;
  readonly now: Date;
}

/** 失敗を記録するときの入力。 */
export interface WalletDeliveryFailureInput {
  readonly id: string;
  /** 次の状態。再試行するなら `PENDING`。 */
  readonly status: Extract<WalletDeliveryOutboxStatus, 'PENDING' | 'FAILED' | 'DEAD'>;
  /** `PENDING` のときだけ意味を持つ。 */
  readonly nextRetryAt: Date;
  readonly errorCode: string;
  /** ⚠️ 応答本文をそのまま入れない。運用が読むための要約だけ。 */
  readonly errorMessage: string | null;
  readonly now: Date;
}

/**
 * OVEW Wallet への配送待ち行列。
 *
 * ⚠️ **`enqueue` は業務状態の変更と同一トランザクションで呼ぶ。**
 * 受取を確定してから別途 INSERT すると、そのあいだに落ちたときに
 * 「受け取ったのに Wallet へ永遠に届かない」行が、誰にも気づかれず残る。
 * この順序を守れない実装は、この port を満たしていない。
 *
 * ⚠️ **`claimBatch` は「探してから書く」実装にしてはならない。**
 * 送る対象を SELECT してから UPDATE すると、複数のワーカーが
 * 同じ行を掴んで**同じイベントを二重に送る**。
 * `FOR UPDATE SKIP LOCKED` で掴み、掴めた行だけを返すこと。
 */
export interface WalletDeliveryOutboxPort {
  /** 配送待ちの行を作る。 */
  enqueue(input: WalletDeliveryEnqueueInput): Promise<WalletDeliveryRecord>;

  /**
   * 送る対象を排他的に取得し、`PROCESSING` へ進めて試行回数を加算する。
   *
   * 取得と状態遷移を分けない。分けると、掴んだあと遷移する前に落ちた行が
   * `PENDING` のまま残り、別のワーカーが同じものを送る。
   */
  claimBatch(input: {
    readonly limit: number;
    readonly now: Date;
  }): Promise<WalletDeliveryRecord[]>;

  /**
   * 配送成功を記録する。
   *
   * ⚠️ **受取権の `wallet_delivery_status` の更新と同一トランザクションで行う。**
   * 行列だけ `DELIVERED` にして受取権を放置すると、
   * 利用者には「お届け中」のまま見え、再送もされない行ができる。
   */
  markDelivered(input: { readonly id: string; readonly now: Date }): Promise<boolean>;

  /** 失敗を記録する。次の状態と再試行時刻は呼び出し元（ドメイン判定）が決める。 */
  recordFailure(input: WalletDeliveryFailureInput): Promise<boolean>;

  /**
   * 手動再送（§20）。`FAILED` / `DEAD` の行を `PENDING` へ戻す。
   *
   * ⚠️ **`event_id` と `payload` は変えない。**
   * 作り直すと相手の冪等キーが変わり、同じ受取権の Holding が 2 つできる。
   * 戻せたかどうかを返す（`PROCESSING` や `DELIVERED` は戻さない）。
   */
  requeue(input: { readonly id: string; readonly now: Date }): Promise<boolean>;

  /**
   * `PROCESSING` のまま取り残された行を `PENDING` へ戻す。
   *
   * ⚠️ **これが無いと、送信中にプロセスが落ちた行が永久に止まる。**
   * `PROCESSING` は誰も拾わないので、再試行もされず、
   * 「受け取ったのに届かない」まま**エラーひとつ出さずに**残る。
   * 止まったまま静かに残るより、相手の冪等性に頼ってでも送り直す方を選ぶ。
   *
   * 試行回数は戻さない。その 1 回は実際に送ろうとしたため。
   *
   * @returns 戻した件数
   */
  reclaimStale(input: { readonly staleBefore: Date; readonly now: Date }): Promise<number>;

  findByEventId(eventId: string): Promise<WalletDeliveryRecord | null>;
}

/**
 * OVEW Wallet への送信そのもの。
 *
 * ⚠️ **実装は本文を組み立て直さない。**
 * 渡された `payload` の文字列に署名し、その文字列をそのまま送る。
 * parse して stringify すると、署名対象と送信内容がずれて必ず失敗する。
 */
export interface WalletDeliverySenderPort {
  send(input: {
    readonly eventId: string;
    readonly correlationId: string;
    /** 署名対象であり、送信本文でもある同一の文字列。 */
    readonly payload: string;
  }): Promise<DeliveryAttemptOutcome>;
}
