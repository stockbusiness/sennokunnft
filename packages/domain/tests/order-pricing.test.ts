import { describe, expect, it } from 'vitest';
import {
  BPS_DENOMINATOR,
  DEFAULT_PLATFORM_FEE_RATE_BPS,
  calculateOrderAmounts,
} from '../src/index';

/**
 * 注文金額の計算（決済仕様書 §5.2・指示書 §6）。
 *
 * ⚠️ **この試験の主題は「合計が必ず一致すること」。**
 * 端数の扱いを間違えると、手数料とクリエイター配分の和が支払額とずれる。
 * ずれは 1 円でも、件数ぶん積み上がって帳簿が合わなくなる。
 */
function amounts(subtotal: number, rateBps: number, discount = 0) {
  const result = calculateOrderAmounts({
    subtotalAmount: subtotal,
    discountAmount: discount,
    platformFeeRateBps: rateBps,
  });
  if (!result.ok) throw new Error(`計算できない: ${result.error.code}`);
  return result.value;
}

describe('注文金額の計算', () => {
  it('支払額は 商品価格 - 値引', () => {
    expect(amounts(1000, 0).totalAmount).toBe(1000);
    expect(amounts(1000, 0, 300).totalAmount).toBe(700);
  });

  it('手数料は 支払額 × 率（bps）', () => {
    // 10% = 1000 bps
    expect(amounts(1000, 1000).platformFeeAmount).toBe(100);
    expect(amounts(1000, 1000).creatorAmount).toBe(900);
  });

  /*
    ⚠️ **端数は切り捨てて、クリエイター側へ寄せる。**
       切り上げると、1 円未満の端数が毎回運営の取り分になる。
       取り分は事業判断で決めるもので、端数処理で黙って足すものではない。
  */
  it('端数は切り捨て、クリエイター側へ寄せる', () => {
    // 999 円 × 10% = 99.9 → 99
    const result = amounts(999, 1000);
    expect(result.platformFeeAmount).toBe(99);
    expect(result.creatorAmount).toBe(900);
  });

  /*
    ⚠️ **ここが本丸。** どんな金額・率でも、手数料 + 配分 = 支払額。
       `creator = total - fee` で求めているので原理的に崩れないが、
       将来ここを書き換えた人が崩したときに気づけるようにしておく。
  */
  it('どの組み合わせでも、手数料と配分の合計が支払額に一致する', () => {
    const subtotals = [0, 1, 7, 99, 100, 333, 999, 1000, 12345, 999_999];
    const rates = [0, 1, 250, 1000, 1500, 3333, 9999, BPS_DENOMINATOR];
    for (const subtotal of subtotals) {
      for (const rate of rates) {
        const result = amounts(subtotal, rate);
        expect(
          result.platformFeeAmount + result.creatorAmount,
          `subtotal=${String(subtotal)} rate=${String(rate)}`,
        ).toBe(result.totalAmount);
        expect(result.platformFeeAmount).toBeGreaterThanOrEqual(0);
        expect(result.creatorAmount).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('率 100% でも配分は負にならない', () => {
    const result = amounts(1000, BPS_DENOMINATOR);
    expect(result.platformFeeAmount).toBe(1000);
    expect(result.creatorAmount).toBe(0);
  });

  it('注文時の率をそのまま持ち帰る', () => {
    // ⚠️ あとでマスタの率が変わっても、この注文の金額は動かさない。
    expect(amounts(1000, 1234).platformFeeRateBps).toBe(1234);
  });

  /*
    ⚠️ **率が決まっていないときの既定は 0。**
       決まっていないものを勝手な数字で埋めると、その数字が既成事実になる。
       0 なら、決める前に走らせてもクリエイターから取りすぎない。
  */
  it('既定の率は 0（事業判断待ち）', () => {
    expect(DEFAULT_PLATFORM_FEE_RATE_BPS).toBe(0);
    const result = amounts(1000, DEFAULT_PLATFORM_FEE_RATE_BPS);
    expect(result.platformFeeAmount).toBe(0);
    expect(result.creatorAmount).toBe(1000);
  });

  describe('受け付けない値', () => {
    it('負の金額', () => {
      expect(calculateOrderAmounts({
        subtotalAmount: -1,
        discountAmount: 0,
        platformFeeRateBps: 0,
      }).ok).toBe(false);
    });

    it('小数の金額', () => {
      expect(calculateOrderAmounts({
        subtotalAmount: 100.5,
        discountAmount: 0,
        platformFeeRateBps: 0,
      }).ok).toBe(false);
    });

    it('100% を超える率', () => {
      // 超えるとクリエイターの取り分が負になる。
      const result = calculateOrderAmounts({
        subtotalAmount: 1000,
        discountAmount: 0,
        platformFeeRateBps: BPS_DENOMINATOR + 1,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('INVALID_FEE_RATE');
    });

    it('小数の率', () => {
      // ⚠️ 率も整数（bps）で扱う。小数で持つと掛けた瞬間に誤差が入る。
      expect(calculateOrderAmounts({
        subtotalAmount: 1000,
        discountAmount: 0,
        platformFeeRateBps: 10.5,
      }).ok).toBe(false);
    });

    it('商品価格を超える値引（支払額が負になる）', () => {
      expect(calculateOrderAmounts({
        subtotalAmount: 1000,
        discountAmount: 1001,
        platformFeeRateBps: 0,
      }).ok).toBe(false);
    });
  });
});
