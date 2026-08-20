import type { RefundReason } from '../order/refund';
import type { RefundStatus } from '../order/order-status';
import type { EntitlementStatus, MintJobStatus } from '../state/machines';

/**
 * 返金の実行と記録（`UD-104` / `UD-120`。`SETTLEMENT_AND_REFUND.md` §3-2）。
 *
 * ⚠️ **記録が先、送信があと。** 決済事業者へ投げてから記録すると、
 * 投げた直後に落ちたときに「返金したのに記録が無い」が残る。金額の
 * 食い違いのうち、いちばん見つけにくい形である。先に `requested` の
 * 行を作り、その行の識別子を事業者の冪等キーにする。
 *
 * ⚠️ **返金は追記のみ。取り消す口を作らない。** 間違えたら再課金であって、
 * 記録を消すことではない。
 */

/** 返金 1 件ぶんの状態。 */
export const REFUND_RECORD_STATUSES = [
  /** 記録しただけ。⚠️ まだ事業者へ届いていない。 */
  'requested',
  /** 事業者が受け付けた。 */
  'succeeded',
  /**
   * 事業者へ届かなかった。
   *
   * ⚠️ **この行を消さない。** 消すと「試したが駄目だった」ことが
   * 記録から消え、同じ操作が繰り返される。
   */
  'failed',
] as const;
export type RefundRecordStatus = (typeof REFUND_RECORD_STATUSES)[number];

/**
 * 誰が起こした返金か（`SETTLEMENT_AND_REFUND.md` §3-2）。
 *
 * ⚠️ **`provider` を「運営の誰か」に丸めない。** 丸めると、こちらを
 * 経由していない返金が見分けられなくなる。運営が慌てて事業者の管理画面
 * から返金するのは実際に起きるので、そこは必ず分けて残す。
 */
export const REFUND_INITIATORS = ['admin', 'provider'] as const;
export type RefundInitiator = (typeof REFUND_INITIATORS)[number];

/** 画面と監査が読む返金の記録。⚠️ 事業者の生の応答は載せない。 */
export interface RefundRecordView {
  readonly id: string;
  readonly orderId: string;
  readonly amount: number;
  readonly currency: string;
  readonly reason: RefundReason;
  readonly status: RefundRecordStatus;
  readonly initiatedBy: RefundInitiator;
  /** 誰が行ったか。⚠️ `provider` なら `null`。 */
  readonly actorAccountId: string | null;
  /** 事業者側の識別子。⚠️ まだ投げていなければ `null`。 */
  readonly providerRefundRef: string | null;
  /** 運用の注記。⚠️ 事業者の応答本文をここへ入れない。 */
  readonly note: string | null;
  /** 失敗の分類。⚠️ 事業者の符号をそのまま入れない。 */
  readonly failureCode: string | null;
  readonly createdAt: Date;
  readonly settledAt: Date | null;
}

/** 返金を記録するときの値。⚠️ 判定は済んでいる前提。 */
export interface StartRefundCommand {
  readonly refundId: string;
  readonly orderId: string;
  /** どの決済を戻すか。⚠️ 世代の鍵はここから解決する（`UD-118`）。 */
  readonly paymentId: string | null;
  readonly amount: number;
  readonly currency: string;
  readonly reason: RefundReason;
  readonly initiatedBy: RefundInitiator;
  readonly actorAccountId: string | null;
  /** 事業者発なら、そのときすでに識別子が分かっている。 */
  readonly providerRefundRef: string | null;
  readonly note: string | null;
  readonly now: Date;
}

/**
 * 返金が成立したときに、注文の周りをどう片づけるか。
 *
 * ⚠️ **`decideRefund` が出した `RefundEffects` をそのまま運ぶ。** ここで
 * 判定し直さない。判定を 2 か所に置くと、片方だけ直る。
 */
export interface SettleRefundCommand {
  readonly refundId: string;
  readonly orderId: string;
  /** 事業者が採番した返金の識別子。⚠️ 追随のときの突き合わせに使う。 */
  readonly providerRefundRef: string | null;
  /**
   * その決済で返した**累計**。
   *
   * ⚠️ **今回ぶんではなく累計を渡す。** 事業者は積算で持つので、
   * 差分で積むと知らせが前後して届いたときに合わなくなる。
   */
  readonly amountRefundedTotal: number;
  /** 受取権を取り消すか。⚠️ 受取り済みなら取り消さない。 */
  readonly revokeEntitlement: boolean;
  /** 発行ジョブを取り消すか。⚠️ `queued` のときだけ。 */
  readonly cancelMintJob: boolean;
  /**
   * `processing` 中の発行ジョブへ残す注記。
   *
   * ⚠️ **取り消さずに注記だけ足す**（`INV-M4`）。外部へ送信済みの
   * 可能性があり、多重発行は回復できない。
   */
  readonly mintNote: string | null;
  readonly now: Date;
}

/** 返金を反映した結果。⚠️ 何が起きたかを 1 件ずつ返す。 */
export interface RefundSettlement {
  /** ⚠️ すでに反映済みだった（同じ返金が 2 経路で届いた）。 */
  readonly alreadySettled: boolean;
  readonly refundStatus: RefundStatus;
  /** 注文全体で返した累計。 */
  readonly amountRefunded: number;
  /** 取り消した受取権の数。 */
  readonly revokedEntitlements: number;
  /** 取り消した発行ジョブの数。 */
  readonly cancelledMintJobs: number;
  /** 注記だけ足した発行ジョブの数（`processing` 中）。 */
  readonly annotatedMintJobs: number;
  /** 在庫へ戻した数。⚠️ 取り消した受取権のぶんだけ。 */
  readonly restoredSupply: number;
}

/** 返金の判定に要る、注文の「いまの姿」を DB から集めたもの。 */
export interface RefundContext {
  readonly orderId: string;
  readonly totalAmount: number;
  readonly currency: string;
  readonly refundableUntil: Date | null;
  readonly paymentStatus: string;
  readonly refundStatus: RefundStatus;
  /** すでに返した累計。 */
  readonly amountRefunded: number;
  /** 戻す先の決済行。⚠️ 成功した決済が無ければ `null`。 */
  readonly paymentId: string | null;
  /**
   * どの世代の鍵で決済したか（`UD-118`）。
   *
   * ⚠️ **これが無いと返金の口を開けない。** `paymentRef` は発行した
   * アカウントに紐づくので、別の鍵では解決できない。
   */
  readonly credentialId: string | null;
  /** 事業者側の決済識別子。⚠️ 返金の宛先。 */
  readonly paymentRef: string | null;
  readonly chargeRef: string | null;
  /**
   * 受取権と発行ジョブの、いちばん進んだ状態。
   *
   * ⚠️ **「いちばん進んだ」で見る。** 1 件でも発行処理中なら、注文と
   * しては人の確認へ回す。件数や平均で丸めない。
   */
  readonly entitlementStatus: EntitlementStatus | null;
  readonly mintStatus: MintJobStatus | null;
}

export interface RefundRepository {
  /** その注文の返金を新しい順に返す。 */
  listByOrder(orderId: string): Promise<readonly RefundRecordView[]>;

  /**
   * 判定に要る値を 1 回で集める。
   *
   * ⚠️ **注文が無ければ `null`。** 「空の姿」を返さない。返すと、
   * 存在しない注文が「未払い」として扱われ、符号が変わる。
   */
  loadContext(orderId: string): Promise<RefundContext | null>;

  /**
   * 返金を `requested` として記録する。
   *
   * ⚠️ **事業者へ投げる前に呼ぶ。** 投げてから記録すると、
   * 途中で落ちたときに「返金したのに記録が無い」が残る。
   */
  start(command: StartRefundCommand): Promise<RefundRecordView>;

  /**
   * 返金の成立を、1 トランザクションで反映する。
   *
   * 実装の責務:
   * 1. 返金の行を `succeeded` にする（条件付き更新。二重反映しない）
   * 2. 決済行の `amount_refunded` を**累計で**置く
   * 3. 注文の `refund_status` を、累計と総額から決め直す
   * 4. 受取権を取り消す（指示があるときだけ）
   * 5. 発行ジョブを取り消す（`queued` のときだけ）／`processing` には注記
   * 6. 取り消した受取権のぶんだけ在庫を戻す
   *
   * ⚠️ **`processing` の発行ジョブを `cancelled` にしない**（`INV-M4`）。
   *
   * ⚠️ **すでに `succeeded` の行なら何もせず、いまの姿を返す。** 事業者の
   * 知らせとこちらの操作が同時に届くことがある。
   */
  settle(command: SettleRefundCommand): Promise<RefundSettlement>;

  /** 事業者へ届かなかったことを記録する。⚠️ 行は消さない。 */
  fail(input: {
    readonly refundId: string;
    readonly failureCode: string;
    readonly now: Date;
  }): Promise<void>;

  /**
   * 事業者が採番した返金の識別子から引く。
   *
   * ⚠️ **こちらから投げた返金にも、あとから知らせが届く。** 識別子で
   * 引き当てないと、同じ返金を 2 回積むことになる。
   */
  findByProviderRef(providerRefundRef: string): Promise<RefundRecordView | null>;
}
