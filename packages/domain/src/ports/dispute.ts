import type { DisputeReason, DisputeStatus } from '../payment/dispute';

/** 記録に残っている争いの姿。 */
export interface DisputeRecord {
  readonly id: string;
  readonly orderId: string;
  readonly paymentId: string | null;
  readonly provider: string;
  readonly disputeRef: string;
  readonly status: DisputeStatus;
  readonly reason: DisputeReason;
  /** ⚠️ **争われている額。** 注文の総額と一致するとは限らない。 */
  readonly amount: number;
  readonly currency: string;
  readonly openedAt: Date;
  readonly closedAt: Date | null;
  /** 敗訴で作った返金。⚠️ 負けるまで `null`。 */
  readonly refundId: string | null;
}

/**
 * 争いの記録。
 *
 * ⚠️ **`RefundRepository` と分けている。** あちらは「返した」の記録で、
 * こちらは「争われている」の記録である。混ぜると、争いが起きただけの
 * 注文が返金済みとして精算から外れる。
 */
export interface DisputePort {
  findByRef(provider: string, disputeRef: string): Promise<DisputeRecord | null>;

  listByOrder(orderId: string): Promise<readonly DisputeRecord[]>;

  /**
   * 受けたことを記録する（無ければ作り、あれば状態を進める）。
   *
   * ⚠️ **`(provider, dispute_ref)` の UNIQUE で 1 行に束ねる。** 申し立て・
   * 審理・決着で別々の知らせが届く。「探して無ければ書く」に崩すと、
   * 同時に届いた知らせで 2 行できて、精算が 2 重に止まる。
   *
   * ⚠️ **決着からは戻さない。** 進められなかったときは `advanced: false`
   * を返す。例外にすると、事業者へ 5xx を返して再送が続く。
   */
  record(input: {
    readonly id: string;
    readonly orderId: string;
    readonly paymentId: string | null;
    readonly provider: string;
    readonly disputeRef: string;
    readonly status: DisputeStatus;
    readonly reason: DisputeReason;
    readonly amount: number;
    readonly currency: string;
    readonly occurredAt: Date;
    readonly now: Date;
  }): Promise<{ readonly record: DisputeRecord; readonly advanced: boolean }>;

  /**
   * 敗訴で作った返金を紐づける。
   *
   * ⚠️ **条件付き更新。** すでに紐づいていたら何もせず `false`。
   * 上書きすると、同じ争いに 2 つの返金がぶら下がる。
   */
  attachRefund(input: {
    readonly disputeId: string;
    readonly refundId: string;
    readonly now: Date;
  }): Promise<boolean>;
}
