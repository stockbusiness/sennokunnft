import type { JobHeartbeat, OperationsCounts } from '../operations/dashboard';
import type { ConsistencyCounts } from '../operations/consistency';

/**
 * 運営ダッシュボードが読む口（P0-6）。
 *
 * ⚠️ **数えるだけ。判定を持たない。** どこを赤くするかはドメインの
 * 純粋関数が決める。ここで色まで決めると、しきい値を変えるのに
 * SQL を触ることになる。
 */
export interface OperationsMetricsPort {
  counts(now: Date): Promise<OperationsCounts>;
  /**
   * 時計仕掛けの生死。
   *
   * ⚠️ **記録の無い種別も返す。** 返さないと画面から項目ごと消え、
   * 「動いていない」ではなく「そんな処理は無い」に見える。
   */
  heartbeats(jobKeys: readonly string[]): Promise<readonly JobHeartbeat[]>;
  recordJobRun(input: {
    readonly jobKey: string;
    readonly outcome: 'succeeded' | 'failed';
    readonly pickedCount?: number | undefined;
    readonly errorCode?: string | undefined;
    readonly now: Date;
  }): Promise<void>;
  /** ⚠️ 直さない。数えるだけ。 */
  consistency(): Promise<ConsistencyCounts>;
}

/** 一覧の 1 行。⚠️ 氏名・メール・受取トークンの項目を持たない。 */
export interface EntitlementAdminRecord {
  readonly id: string;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly artworkId: string;
  readonly artworkTitle: string;
  readonly serialNo: number;
  readonly status: string;
  readonly walletDeliveryStatus: string;
  readonly claimedByCommonUserId: string | null;
  readonly claimedAt: Date | null;
  readonly walletDeliveredAt: Date | null;
  readonly createdAt: Date;
}

export interface EntitlementAdminDetailRecord extends EntitlementAdminRecord {
  readonly orderLineId: string;
  readonly accountId: string;
  /** ⚠️ 本文は含めない。 */
  readonly deliveries: readonly {
    readonly id: string;
    readonly eventId: string;
    readonly eventType: string;
    readonly status: string;
    readonly attemptCount: number;
    readonly lastErrorCode: string | null;
    readonly deliveredAt: Date | null;
    readonly createdAt: Date;
  }[];
}

/**
 * 受取権を運営が見る口（P0-6）。
 *
 * ⚠️ **買った方の個人情報を持ち出さない。** 型に項目が無いので、
 * 実装側がうっかり載せても呼び出し側では読めない（`UD-503`）。
 */
export interface EntitlementAdminPort {
  list(query: {
    readonly status?: string | undefined;
    readonly walletDeliveryStatus?: string | undefined;
    readonly orderId?: string | undefined;
    readonly accountId?: string | undefined;
    readonly limit: number;
    readonly cursor?: string | undefined;
  }): Promise<{
    readonly items: readonly EntitlementAdminRecord[];
    readonly nextCursor: string | null;
  }>;

  findById(id: string): Promise<EntitlementAdminDetailRecord | null>;

  /**
   * その方の、まだ届いていない受取権。
   *
   * ⚠️ **「受け取り済みで未配送」に絞る。** 未受取の分はウォレットの
   * 登録がまだで、送る先が無い。
   */
  listUndeliveredForAccount(accountId: string, limit: number): Promise<readonly string[]>;
}
