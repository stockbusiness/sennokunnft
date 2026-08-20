import type { PayoutCandidate, PayoutClawback, PayoutStatus } from '../settlement/payout';
import type { TransferFeeBearer } from '../settlement/settings';

/**
 * 精算の永続化境界（`UD-119`）。
 *
 * ⚠️ **金額を人が直接書き換える口を作らない**（`SETTLEMENT_AND_REFUND.md` §4）。
 * ここに `updateAmount` の類を足さないこと。訂正は**次の期間での調整**として
 * 行う。直接書き換えを許すと、明細と振込額が食い違ったときに、どちらが
 * 正しいのか誰にも分からなくなる。
 *
 * ⚠️ **二重払いは DB で防ぐ。** `payout_lines` の `UNIQUE (order_id)` が
 * 「同じ注文が 2 回精算に入る」を止める。アプリの注意力に頼らない。
 */

/** 画面と監査が読む精算。⚠️ 個人を特定する値は載せない。 */
export interface PayoutView {
  readonly id: string;
  readonly creatorAccountId: string;
  /** `2026-08` の形。 */
  readonly periodKey: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  /** お支払いの期日。⚠️ 焼き付けた値。設定を変えても動かない。 */
  readonly dueAt: Date;
  readonly status: PayoutStatus;
  readonly currency: string;
  readonly grossAmount: number;
  readonly feeAmount: number;
  readonly refundedAmount: number;
  readonly carriedInAmount: number;
  readonly netAmount: number;
  readonly carriedOutAmount: number;
  /** ⚠️ **その時点の**設定。焼き付けてある。 */
  readonly minimumPayoutAmount: number;
  readonly transferFeeBearer: TransferFeeBearer;
  readonly confirmedAt: Date | null;
  readonly paidAt: Date | null;
  readonly paidByAccountId: string | null;
  readonly lineCount: number;
  readonly createdAt: Date;
}

/** 明細 1 行。⚠️ すべて注文からの写し。 */
export interface PayoutLineView {
  readonly id: string;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly artworkTitleSnapshot: string;
  readonly grossAmount: number;
  readonly feeRateBps: number;
  readonly feeAmount: number;
  readonly netAmount: number;
  readonly isClawback: boolean;
}

/** 精算を保存するときの値。⚠️ 金額は `buildPayoutDraft` が決めた値。 */
export interface SavePayoutDraftCommand {
  readonly payoutId: string;
  readonly creatorAccountId: string;
  readonly periodKey: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly dueAt: Date;
  readonly currency: string;
  readonly grossAmount: number;
  readonly feeAmount: number;
  readonly refundedAmount: number;
  readonly carriedInAmount: number;
  readonly netAmount: number;
  readonly carriedOutAmount: number;
  readonly minimumPayoutAmount: number;
  readonly transferFeeBearer: TransferFeeBearer;
  readonly lines: readonly {
    readonly id: string;
    readonly orderId: string;
    readonly orderNumber: string;
    readonly artworkTitleSnapshot: string;
    readonly grossAmount: number;
    readonly feeRateBps: number;
    readonly feeAmount: number;
    readonly netAmount: number;
    readonly isClawback: boolean;
  }[];
  readonly now: Date;
}

export interface PayoutRepository {
  /** 一覧。⚠️ 新しい期間から。 */
  list(query: {
    readonly limit: number;
    readonly periodKey?: string | undefined;
    readonly creatorAccountId?: string | undefined;
    readonly status?: PayoutStatus | undefined;
  }): Promise<readonly PayoutView[]>;

  findById(payoutId: string): Promise<PayoutView | null>;

  listLines(payoutId: string): Promise<readonly PayoutLineView[]>;

  /**
   * その期間・その作家さまの精算を引く。
   *
   * ⚠️ **同じ期間の下書きを 2 つ作らせないため。** 作り直しは既存の
   * 下書きを置き換える形で行う。
   */
  findByPeriod(creatorAccountId: string, periodKey: string): Promise<PayoutView | null>;

  /**
   * 精算の対象になる注文を集める。
   *
   * 実装の責務:
   *   - 決済が成立し（`payment_status = 'succeeded'`）
   *   - `paid_at` がその期間に入り
   *   - **返金されていない**（`refund_status = 'none'`）
   *   - **まだどの精算にも載っていない**（`payout_lines` に無い）
   *
   * ⚠️ **「返金の窓が閉じたか」はここで絞らない。** 下書きは窓が開いた
   * ままでも作れてよい（運営が見通しを持てる方がよい）。確定だけを
   * `canConfirmPayout` が止める。
   */
  listCandidates(input: {
    readonly creatorAccountId: string;
    readonly periodStart: Date;
    readonly periodEnd: Date;
  }): Promise<readonly PayoutCandidate[]>;

  /**
   * 確定済みの精算に載っていたのに、あとから返金された注文。
   *
   * ⚠️ **次回以降から差し引く**（`SETTLEMENT_AND_REFUND.md` §2-3）。
   * ⚠️ **一度差し引いた注文を二度引かない。** 実装は差し戻しの行
   * （`is_clawback = true`）がすでにあるものを除くこと。
   */
  listClawbacks(creatorAccountId: string): Promise<readonly PayoutClawback[]>;

  /**
   * その精算に載っている注文のうち、返金の窓がまだ開いているものの数。
   *
   * ⚠️ **候補の絞り込み（`listCandidates`）で数えない。** あちらは
   * 「まだどの精算にも載っていない注文」を返すので、下書きを保存した
   * 直後は 0 件になる。**この精算の明細そのもの**から数える。
   *
   * ⚠️ **期限が付いていない注文も「開いている」と数える。** 分からない
   * ものを、分かったことにしない。
   */
  countOpenRefundWindows(payoutId: string, now: Date): Promise<number>;

  /** 前の期間から持ち越された額。⚠️ 無ければ 0。 */
  carriedInAmount(creatorAccountId: string, previousPeriodKey: string): Promise<number>;

  /**
   * 精算の対象になる作家さまを、その期間から洗い出す。
   *
   * ⚠️ **繰越だけの作家さまも含める。** 今月の売上が 0 でも、前月からの
   * 繰越があれば支払う月かもしれない。売上だけで絞ると、繰り越した額が
   * いつまでも支払われない。
   */
  listCreatorsForPeriod(input: {
    readonly periodStart: Date;
    readonly periodEnd: Date;
    readonly previousPeriodKey: string;
  }): Promise<readonly string[]>;

  /**
   * 下書きを保存する（作り直しなら置き換える）。
   *
   * ⚠️ **`draft` のときだけ置き換えてよい。** `confirmed` 以降を置き換える
   * 実装にしないこと。締めたあとに金額が動くと、渡した明細と食い違う。
   */
  saveDraft(command: SavePayoutDraftCommand): Promise<PayoutView>;

  /**
   * 状態を進める。
   *
   * ⚠️ **条件付き更新で行う。** 「読んでから書く」にすると、同時に押された
   * 「確定」が 2 回通る。
   *
   * @returns 進められたら新しい姿。すでに進んでいたら `null`。
   */
  advance(input: {
    readonly payoutId: string;
    readonly from: PayoutStatus;
    readonly to: PayoutStatus;
    readonly actorAccountId: string;
    readonly now: Date;
  }): Promise<PayoutView | null>;
}
