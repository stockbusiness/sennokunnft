import type {
  EntitlementDisposition,
  RefundCategory,
  RefundRequestReason,
  RefundRequestStatus,
} from '../refund/request';
import type { ReceivableRecord, ReceivableStatus } from '../refund/receivable';
import type { IntegrationEnvironment } from '../integration/service';

/**
 * 返金の申請（方針整理 2026-08-22）。
 *
 * ⚠️ **既存の `RefundRepository` を置き換えない。** あちらは
 * **決済事業者への返金そのもの**の記録で、こちらは**その手前の手続き**である。
 * 1 つにまとめると、事業者へ投げていない申請と投げた返金が同じ表に混ざる。
 */
export interface RefundRequestRecord {
  readonly id: string;
  readonly orderId: string;
  readonly status: RefundRequestStatus;
  readonly reason: RefundRequestReason;
  readonly category: RefundCategory;
  /** 運営の書き込み。⚠️ 購入者には見せない。 */
  readonly note: string | null;
  /** 購入者が書いた申し出の内容。⚠️ 文字として扱う（HTML にしない）。 */
  readonly buyerStatement: string | null;
  readonly amount: number;
  readonly isFullRefund: boolean;
  readonly entitlementDisposition: EntitlementDisposition;
  /** 誰が申し出たか。⚠️ 購入者自身なら購入者のアカウント。 */
  readonly requestedByAccountId: string | null;
  /** 誰が調べたか。 */
  readonly reviewedByAccountId: string | null;
  /** 誰が承認したか。⚠️ 二重承認では申請者と別人である。 */
  readonly approvedByAccountId: string | null;
  readonly dualApprovalRequired: boolean;
  /** 原則対象外を、運営が例外として通したか。 */
  readonly approvedAsException: boolean;
  /** 却下の理由。⚠️ 必ず残す。 */
  readonly rejectionNote: string | null;
  /** 実行してできた返金の行。まだなら `null`。 */
  readonly refundId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** 申請に起きたこと 1 行。⚠️ 追記のみ（直す口も消す口も無い）。 */
export interface RefundRequestEventRecord {
  readonly id: string;
  readonly action: string;
  readonly actorAccountId: string | null;
  /** 金額と符号まで。⚠️ 購入者の申し出の本文をここへ写さない。 */
  readonly summary: Record<string, unknown>;
  readonly createdAt: Date;
}

export interface RefundRequestQuery {
  readonly limit: number;
  readonly status?: RefundRequestStatus | undefined;
  readonly orderId?: string | undefined;
  readonly creatorAccountId?: string | undefined;
}

/** 作家さまへの事実確認。⚠️ 回答は任意（期限が来れば運営だけで進む）。 */
export interface CreatorInquiryRecord {
  readonly id: string;
  readonly requestId: string;
  readonly creatorAccountId: string;
  readonly askedAt: Date;
  readonly dueAt: Date;
  readonly answeredAt: Date | null;
  /** 作家さまの回答。⚠️ 文字として扱う。 */
  readonly answer: string | null;
  /** 添付の保管庫の鍵。⚠️ URL ではなく鍵で持つ。 */
  readonly attachmentKeys: readonly string[];
}

export interface RefundRequestPort {
  find(id: string): Promise<RefundRequestRecord | null>;
  list(query: RefundRequestQuery): Promise<readonly RefundRequestRecord[]>;
  /** 同じ注文に、まだ決着していない申請があるか。⚠️ 二重申請を止める。 */
  findOpenByOrder(orderId: string): Promise<RefundRequestRecord | null>;

  create(input: {
    readonly id: string;
    readonly orderId: string;
    readonly reason: RefundRequestReason;
    readonly category: RefundCategory;
    readonly amount: number;
    readonly isFullRefund: boolean;
    readonly entitlementDisposition: EntitlementDisposition;
    readonly requestedByAccountId: string | null;
    readonly buyerStatement: string | null;
    readonly status: RefundRequestStatus;
    readonly now: Date;
  }): Promise<RefundRequestRecord>;

  /**
   * 状態を進める。
   *
   * ⚠️ **条件付き更新にする。** 「読んでから書く」にすると、2 人が同時に
   * 承認したときに両方通り、**二重返金の入口になる**。
   *
   * @returns 進められたか。⚠️ `false` は「すでに誰かが進めた」。
   */
  transition(input: {
    readonly id: string;
    readonly from: readonly RefundRequestStatus[];
    readonly to: RefundRequestStatus;
    readonly patch?:
      | {
          readonly reviewedByAccountId?: string | undefined;
          readonly approvedByAccountId?: string | undefined;
          readonly dualApprovalRequired?: boolean | undefined;
          readonly approvedAsException?: boolean | undefined;
          readonly entitlementDisposition?: EntitlementDisposition | undefined;
          readonly amount?: number | undefined;
          readonly isFullRefund?: boolean | undefined;
          readonly note?: string | undefined;
          readonly rejectionNote?: string | undefined;
          readonly refundId?: string | undefined;
        }
      | undefined;
    readonly now: Date;
  }): Promise<boolean>;

  /**
   * 起きたことを 1 行残す。
   *
   * ⚠️ **追記のみ。** 直す口も消す口も無い（DB のトリガーが拒む）。
   * ⚠️ **金額と符号まで。** 購入者の申し出の本文をここへ写さない。
   */
  /**
   * 起きたことを古い順に読む。
   *
   * ⚠️ **限りを付ける。** 何度もやり直した申請では行が伸びる。
   */
  listEvents(requestId: string, limit: number): Promise<readonly RefundRequestEventRecord[]>;

  appendEvent(input: {
    readonly id: string;
    readonly requestId: string;
    readonly action: string;
    readonly actorAccountId: string | null;
    readonly summary: Record<string, unknown>;
    readonly now: Date;
  }): Promise<void>;
}

export interface CreatorInquiryPort {
  findByRequest(requestId: string): Promise<CreatorInquiryRecord | null>;
  /** 作家さまが答えるべきもの。⚠️ その方の分だけ。 */
  listForCreator(creatorAccountId: string, limit: number): Promise<readonly CreatorInquiryRecord[]>;
  ask(input: {
    readonly id: string;
    readonly requestId: string;
    readonly creatorAccountId: string;
    readonly dueAt: Date;
    readonly now: Date;
  }): Promise<CreatorInquiryRecord>;
  /**
   * 回答する。
   *
   * ⚠️ **期限を過ぎても受け付ける。** 遅れて届いた事実にも値打ちがある。
   * 期限の意味は「待たずに進めてよい」であって「もう聞かない」ではない。
   *
   * @returns 受け付けたか。⚠️ `false` は「すでに答えている」。
   */
  answer(input: {
    readonly requestId: string;
    readonly creatorAccountId: string;
    readonly answer: string;
    readonly attachmentKeys: readonly string[];
    readonly now: Date;
  }): Promise<boolean>;
}

export interface CreatorReceivablePort {
  listOutstanding(creatorAccountId: string): Promise<readonly ReceivableRecord[]>;
  record(input: {
    readonly id: string;
    readonly creatorAccountId: string;
    readonly orderId: string;
    readonly amount: number;
    readonly now: Date;
  }): Promise<void>;
  /** 状態を進める。⚠️ 金額は書き換えない（記録であって帳簿ではない）。 */
  settle(input: {
    readonly id: string;
    readonly status: Exclude<ReceivableStatus, 'outstanding'>;
    readonly actorAccountId: string;
    readonly now: Date;
  }): Promise<boolean>;
}

/**
 * 返金の審査にかかる設定。
 *
 * ⚠️ **`SettlementSettings` へ足していない。** あちらは**注文へ焼き付ける
 * ための材料**（返金期限・最低支払額）で、判定のたびに読んではいけない値が
 * 集まっている（`SETTLEMENT_AND_REFUND.md` §0 の三層）。こちらは逆に
 * **いま審査する人の手続き**を決める値で、変えたら次の審査から効いてよい。
 * 同じ行に載っていても、意味が違うので口を分ける。
 *
 * ⚠️ **環境変数へ黙って落とさない。** 行が無ければ「未設定」を返し、
 * 呼ぶ側が断る。既定値でそっと動かすと、しきい値を設定したつもりの
 * 配備で二重承認が効いていない、という状態が起こる。
 */
export interface RefundPolicy {
  /** 作家さまの回答期限（営業日）。 */
  readonly creatorInquiryBusinessDays: number;
  /**
   * 二重承認が要る額（円）。
   *
   * ⚠️ **`null` は「二重承認を使わない」。** 0 をその意味に使わない
   * ——設定を消し忘れたのか、全件に課したいのかが読めなくなる。
   */
  readonly dualApprovalThresholdAmount: number | null;
}

export interface RefundPolicyPort {
  /** @returns 設定。⚠️ **行が無ければ `null`**（既定値で埋めない）。 */
  find(environment: IntegrationEnvironment): Promise<RefundPolicy | null>;
}
