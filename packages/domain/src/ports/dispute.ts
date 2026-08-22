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
  /** 証拠の提出期限。⚠️ 過ぎると自動的に負ける。 */
  readonly evidenceDueAt: Date | null;
  readonly closedAt: Date | null;
  /** 敗訴で作った返金。⚠️ 負けるまで `null`。 */
  readonly refundId: string | null;
}

/**
 * 一覧に出す 1 件（2026-08-22）。
 *
 * ⚠️ **購入者を特定できる値を持たない。** 氏名・メール・住所は入れない
 * （`UD-503`）。争いを追うのに要るのは注文番号までで、そこから先は注文の
 * 画面が本人確認を経て見せる。ここに入れると、一覧を見られる人すべてが
 * 見られることになる。
 *
 * ⚠️ **作品名は注文時点の写し。** マスタを引き直さない。改名したときに
 * 過去の争いの見え方まで変わる。
 */
export interface DisputeListItem extends DisputeRecord {
  readonly orderNumber: string;
  readonly artworkTitleSnapshot: string;
  /** 注文の総額。⚠️ 争われている額（`amount`）と一致するとは限らない。 */
  readonly orderTotalAmount: number;
}

/** 一覧の絞り込み。 */
export interface DisputeListQuery {
  /**
   * `open` は決着していないもの（**警告を含む**）。
   *
   * ⚠️ **精算を止める条件とは別である。** あちらは警告を含めない
   * （消える警告のぶんまでお支払いを遅らせないため）。こちらは人が見る
   * 一覧で、**警告こそ早めに知りたい**——申し立てになる前に手を打てる。
   */
  readonly state: 'open' | 'closed' | 'all';
  /** ⚠️ 上限。超えた分は返さないが、超えたことは隠さない。 */
  readonly limit: number;
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
   * 運営が見る一覧（2026-08-22）。
   *
   * ⚠️ **並びは「期限の早い順」。** 起きた順にすると、期限が明日のものが
   * 二枚目に沈む。期限を持たないものは後ろへ回す。
   *
   * ⚠️ **上限で切ったことを返す。** 黙って切ると、全部見えていると
   * 読まれる。`hasMore` が立っていたら、まだ先がある。
   */
  list(query: DisputeListQuery): Promise<{
    readonly items: readonly DisputeListItem[];
    readonly hasMore: boolean;
  }>;

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
    readonly evidenceDueAt: Date | null;
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
