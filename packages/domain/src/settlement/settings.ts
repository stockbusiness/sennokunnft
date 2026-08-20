import { domainError, type DomainError } from '../shared/errors';
import { err, ok, type Result } from '../shared/result';

/**
 * 返金と精算の設定（`UD-104` / `UD-119`）。
 *
 * ⚠️ **この値は必ず変わる。** 変わったときに困るのは値そのものではなく、
 * **過去の記録の意味が変わってしまうこと**である
 * （`docs/SETTLEMENT_AND_REFUND.md` §0）。
 *
 * そこで三層に分ける:
 *   ① 設定（この型）……いま何を使うか。DB にあり、オーナーが変える
 *   ② スナップショット……そのとき何を使ったか。注文・返金・精算へ焼き付ける
 *   ③ 判断（純粋関数）……②を引数で受け取る。**①を知らない**
 *
 * ⚠️ **③ から ① を読まないこと。** 読むと、過去の記録を判定し直したときに
 * 今の設定で判定されてしまう。「先月の注文はまだ返金できる」が
 * 設定を変えた瞬間に生まれる。
 */

/** 振込手数料を誰が負担するか。 */
export const TRANSFER_FEE_BEARERS = ['creator', 'platform'] as const;
export type TransferFeeBearer = (typeof TRANSFER_FEE_BEARERS)[number];

export interface SettlementSettings {
  /**
   * 返金を受け付ける日数（決済完了から）。
   *
   * ⚠️ **注文へ期限として焼き付けるための材料。** 判定のたびにここを
   * 読んではいけない。読むと、値を変えた瞬間に過去の注文の期限が動く。
   */
  readonly refundWindowDays: number;
  /** 精算の締めから支払いまでの月数。1 なら「月末締め・翌月末払い」。 */
  readonly payoutOffsetMonths: number;
  /** 最低支払額（円）。未満は翌月へ繰り越す。 */
  readonly minimumPayoutAmount: number;
  readonly transferFeeBearer: TransferFeeBearer;
}

/**
 * 受け付ける範囲。
 *
 * ⚠️ **上限を設ける理由は「打ち間違いを止める」こと。** 返金期間に
 * `3650`（10 年）と打たれると、その間ずっと精算できない注文が積み上がる。
 * 気づくのは作家さまから「入金がない」と言われたときになる。
 */
export const REFUND_WINDOW_DAYS_MIN = 0;
export const REFUND_WINDOW_DAYS_MAX = 180;
export const PAYOUT_OFFSET_MONTHS_MIN = 0;
export const PAYOUT_OFFSET_MONTHS_MAX = 6;
export const MINIMUM_PAYOUT_AMOUNT_MAX = 100_000;

/**
 * 設定を検証する。
 *
 * ⚠️ **`0` を弾かない。** 返金期間 `0` は「返金を受け付けない」という
 * 正しい設定である。金額と違い、ここでの `0` は「未設定」ではない。
 */
export function validateSettlementSettings(
  input: SettlementSettings,
): Result<SettlementSettings, DomainError> {
  const { refundWindowDays, payoutOffsetMonths, minimumPayoutAmount } = input;

  if (
    !Number.isInteger(refundWindowDays) ||
    refundWindowDays < REFUND_WINDOW_DAYS_MIN ||
    refundWindowDays > REFUND_WINDOW_DAYS_MAX
  ) {
    return err(domainError('SETTLEMENT_SETTINGS_INVALID', 'refund window out of range'));
  }
  if (
    !Number.isInteger(payoutOffsetMonths) ||
    payoutOffsetMonths < PAYOUT_OFFSET_MONTHS_MIN ||
    payoutOffsetMonths > PAYOUT_OFFSET_MONTHS_MAX
  ) {
    return err(domainError('SETTLEMENT_SETTINGS_INVALID', 'payout offset out of range'));
  }
  // ⚠️ 金額は円の整数（コーディング規約）。
  if (
    !Number.isInteger(minimumPayoutAmount) ||
    minimumPayoutAmount < 0 ||
    minimumPayoutAmount > MINIMUM_PAYOUT_AMOUNT_MAX
  ) {
    return err(domainError('SETTLEMENT_SETTINGS_INVALID', 'minimum payout out of range'));
  }

  /*
    ⚠️ **返金の窓が精算より後に閉じる設定を止める。**
       返金期間が精算までの猶予を超えると、「支払い済みの注文が返金される」
       が常態になる。作家さまから返してもらう作業が毎月発生し、
       少額なら回収を諦めることになる（`SETTLEMENT_AND_REFUND.md` §2-3）。

    ⚠️ 締めが月末なので、猶予は最短でも「その月の残り + オフセットの月数」。
       月の末日に決済された注文が最短で、猶予はほぼ `payoutOffsetMonths` か月。
       28 日を 1 か月の最短として見る。
  */
  const shortestPayoutDelayDays = payoutOffsetMonths * 28;
  if (refundWindowDays > shortestPayoutDelayDays) {
    return err(
      domainError('SETTLEMENT_SETTINGS_INVALID', 'refund window outlasts the payout delay'),
    );
  }

  return ok(input);
}

/**
 * 返金を受け付ける期限を、決済確定の時点で確定する。
 *
 * ⚠️ **注文へ焼き付けるためだけに呼ぶ。** 判定のときに呼び直さない。
 * 呼び直すと、設定を変えた瞬間に過去の注文の期限が動く。
 */
export function refundableUntil(paidAt: Date, refundWindowDays: number): Date {
  return new Date(paidAt.getTime() + refundWindowDays * 86_400_000);
}
