import type { JobHeartbeat, OperationsCounts } from '../operations/dashboard';
import type { ConsistencyCounts } from '../operations/consistency';
import type { ReservedCountDriftRecord } from '../operations/reserved-count-drift';
import type {
  ReservedCountRepairCommand,
  ReservedCountRepairRecord,
  ReservedCountRepairRefusal,
  ReservedCountRepairResolveRefusal,
} from '../operations/reserved-count-repair';

/**
 * 運営ダッシュボードが読む口（P0-6）。
 *
 * ⚠️ **数えるだけ。判定を持たない。** どこを赤くするかはドメインの
 * 純粋関数が決める。ここで色まで決めると、しきい値を変えるのに
 * SQL を触ることになる。
 */
export interface OperationsMetricsPort {
  /**
   * いまの数。
   *
   * ⚠️ **`disputeDueSoonBefore` を呼び出し側から渡す。** 「期限が近い」の
   * しきい値は設定であって、リポジトリが決めることではない。ここで
   * 定数にすると、変えるたびにデプロイが要る。
   */
  counts(now: Date, disputeDueSoonBefore: Date): Promise<OperationsCounts>;
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
  /**
   * 押さえがずれた作品を、数値と関わっている注文つきで返す。
   *
   * ⚠️ **`consistency()` と重ねて数えない。** あちらは「何件あるか」、
   * こちらは「どこがどうずれたか」。役割が違うので分けてある。
   *
   * ⚠️ **上限で切ったことを隠さない。** 切ったなら `hasMore` で伝える。
   */
  reservedCountDrift(limit: number): Promise<{
    readonly items: readonly ReservedCountDriftRecord[];
    readonly hasMore: boolean;
  }>;
}

/** 作品そのものが見つからない。⚠️ ずれの判定より前に起きる。 */
export type ReservedCountRepairMissing = 'artwork_not_found';

export type ReservedCountRepairOutcome =
  | { readonly ok: true; readonly record: ReservedCountRepairRecord }
  | {
      readonly ok: false;
      readonly refusal: ReservedCountRepairRefusal | ReservedCountRepairMissing;
    };

export type ReservedCountRepairResolveOutcome =
  | { readonly ok: true; readonly record: ReservedCountRepairRecord }
  | { readonly ok: false; readonly refusal: ReservedCountRepairResolveRefusal | 'not_found' };

/**
 * 押さえのずれを直す口（`ADMIN_OPERATIONS_GAP.md` §I・2026-08-24 決定）。
 *
 * ⚠️ **一括で直す口を置かない。** ずれはバグ由来だと同時に何十件も出る。
 * 一括だと **1 回の操作で、本人が下していない判断を数十件ぶん下せてしまう。**
 * 1 件ずつなら「50 回押している」こと自体が異常の合図になる。
 *
 * ⚠️ **夜間に自動で直す口も置かない。** 自動で直すと 0 件が常態になり、
 * 整合性チェックが何も教えてくれなくなる。
 */
export interface ReservedCountRepairPort {
  /**
   * 1 件だけ直す。
   *
   * ⚠️ **作品行を掴んだまま数え直すこと。** 画面を開いてから押すまでに
   * 正常なご注文が入ると、古い数字で上書きして**逆にずれを作る。**
   * 掴んで読んだ値が `command.observedReservedCount` と違えば直さない。
   */
  repair(input: {
    readonly command: ReservedCountRepairCommand;
    readonly actorAccountId: string;
    readonly now: Date;
  }): Promise<ReservedCountRepairOutcome>;

  /**
   * 直した記録を新しい順に返す。
   *
   * ⚠️ **上限で切ったことを隠さない。** 切ったなら `hasMore` で伝える。
   */
  list(query: {
    /** `pending` は原因未特定かつ未解消のみ。⚠️ 既定はこちら。 */
    readonly state: 'pending' | 'all';
    readonly limit: number;
  }): Promise<{
    readonly items: readonly ReservedCountRepairRecord[];
    readonly hasMore: boolean;
  }>;

  /**
   * 原因未特定の積み残しを閉じる。
   *
   * ⚠️ **消す操作ではない。** 何が分かったのかを書かせ、`resolved_*` を
   * 埋めるだけ。`before` / `after` / `snapshot` には触らない。
   */
  resolve(input: {
    readonly repairId: string;
    readonly note: string;
    readonly actorAccountId: string;
    readonly now: Date;
  }): Promise<ReservedCountRepairResolveOutcome>;

  /**
   * 原因未特定のまま残っている件数。
   *
   * ⚠️ **これがこの機能の心臓部。** 整合性チェックは修復で 0 件に戻るが、
   * この数は残る。**直したことで赤が消えるのを許さない**ためにある。
   */
  pendingCount(): Promise<number>;
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
