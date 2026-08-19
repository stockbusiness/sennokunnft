import { domainError, type DomainError } from '../shared/errors';
import { err, ok, type Result } from '../shared/result';

/**
 * 注文金額の計算（決済仕様書 §5.2・指示書 §6）。
 *
 * ⚠️ **計算をここ 1 か所に集める。** 注文作成・管理画面・将来の返金で
 * 同じ式を書き直すと、いつか片方だけ直されて金額が合わなくなる。
 *
 * ⚠️ **すべて整数。** 金額に浮動小数点を使わない。
 * 手数料率も**ベーシスポイント（1/100 %）の整数**で持つ。
 * `0.1` のような小数で率を持つと、掛けた瞬間に誤差が入る。
 * 「率だけは小数でよい」は成り立たない——掛ける相手が金額だから。
 */

/** 手数料率の単位。10000 bps = 100%。 */
export const BPS_DENOMINATOR = 10_000;

/**
 * 手数料率が設定されていないときの既定値。
 *
 * ⚠️ **0 にしてある。** 率は事業判断待ち（指示書 §6 末尾・仕様書 §22）。
 * 決まっていないものを勝手な数字で埋めると、その数字が既成事実になる。
 * 0 なら「まだ決めていない」ことが金額に表れ、決める前に本番で
 * 走らせてしまっても**クリエイターから取りすぎることはない**。
 *
 * ⚠️ **決まったら環境設定で与える。** ここを書き換えて配ると、
 * 過去の注文の意味まで変わったように見える。注文には常に
 * そのときの率をスナップショットで残す。
 */
export const DEFAULT_PLATFORM_FEE_RATE_BPS = 0;

export interface PricingInput {
  /** 商品の税込価格（単価 × 数量）。 */
  readonly subtotalAmount: number;
  /** 値引額。⚠️ 今回は常に 0。列と計算だけ先に用意する。 */
  readonly discountAmount: number;
  /** 注文時点の手数料率（bps）。 */
  readonly platformFeeRateBps: number;
}

export interface OrderAmounts {
  readonly subtotalAmount: number;
  readonly discountAmount: number;
  /** 購入者が支払う額。 */
  readonly totalAmount: number;
  /** ⚠️ 注文時点の率をそのまま持ち帰る。あとで率が変わっても動かさない。 */
  readonly platformFeeRateBps: number;
  readonly platformFeeAmount: number;
  readonly creatorAmount: number;
}

/**
 * 注文の金額を確定する。
 *
 * ```text
 * total       = subtotal - discount
 * platformFee = floor(total × rate / 10000)
 * creator     = total - platformFee
 * ```
 *
 * ⚠️ **端数は切り捨て、クリエイター側へ寄せる。** 手数料を切り上げると、
 * 1 円未満の端数が毎回運営の取り分になる。取り分を決めるのは事業判断で、
 * 端数処理で黙って足すものではない。
 *
 * ⚠️ **`creator = total - fee` で求める。** それぞれを率から計算すると、
 * 端数の分だけ合計が `total` に一致しなくなる。引き算にすれば、
 * **合計が一致しないことが原理的に起こらない。**
 */
export function calculateOrderAmounts(input: PricingInput): Result<OrderAmounts, DomainError> {
  const { subtotalAmount, discountAmount, platformFeeRateBps } = input;

  if (!isNonNegativeInteger(subtotalAmount)) {
    return err(domainError('INVALID_MONEY', 'subtotal must be a non-negative integer'));
  }
  if (!isNonNegativeInteger(discountAmount)) {
    return err(domainError('INVALID_MONEY', 'discount must be a non-negative integer'));
  }
  if (!isNonNegativeInteger(platformFeeRateBps) || platformFeeRateBps > BPS_DENOMINATOR) {
    // 100% を超える手数料は、クリエイターの取り分を負にする。
    return err(domainError('INVALID_FEE_RATE', 'fee rate must be between 0 and 10000 bps'));
  }
  if (discountAmount > subtotalAmount) {
    // ⚠️ 支払額を負にしない。返金は別の仕組みで表す。
    return err(domainError('INVALID_MONEY', 'discount must not exceed subtotal'));
  }

  const totalAmount = subtotalAmount - discountAmount;
  const platformFeeAmount = Math.floor((totalAmount * platformFeeRateBps) / BPS_DENOMINATOR);
  const creatorAmount = totalAmount - platformFeeAmount;

  /*
    ⚠️ **不変条件をここで確かめる。** 上の式なら必ず成り立つが、
       将来ここを書き換えた人が崩したときに、静かに配分がずれるより
       止まったほうがよい。お金の計算は、間違ったまま進むのが最悪。
  */
  if (platformFeeAmount + creatorAmount !== totalAmount) {
    return err(domainError('INVALID_MONEY', 'fee and creator amount must sum to total'));
  }
  if (platformFeeAmount < 0 || creatorAmount < 0) {
    return err(domainError('INVALID_MONEY', 'amounts must not be negative'));
  }

  return ok({
    subtotalAmount,
    discountAmount,
    totalAmount,
    platformFeeRateBps,
    platformFeeAmount,
    creatorAmount,
  });
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
