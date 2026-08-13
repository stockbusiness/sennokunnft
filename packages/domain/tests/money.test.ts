import { describe, expect, it } from 'vitest';
import {
  addMoney,
  createMoney,
  multiplyMoney,
  subtractMoney,
  validateQuantity,
  MAX_QUANTITY_PER_ORDER,
} from '../src/index';

describe('Money（TEST_STRATEGY §3.4）', () => {
  it('整数の金額を受け付ける', () => {
    const money = createMoney(12000, 'JPY');
    expect(money.ok).toBe(true);
  });

  it('小数を拒否する（A-1: 浮動小数点で金額を扱わない）', () => {
    const money = createMoney(120.5, 'JPY');
    expect(money.ok).toBe(false);
    if (money.ok) throw new Error('expected failure');
    expect(money.error.code).toBe('INVALID_MONEY');
  });

  it('負の金額を拒否する（A-3）', () => {
    expect(createMoney(-1, 'JPY').ok).toBe(false);
  });

  it('安全整数を超える金額を拒否する', () => {
    expect(createMoney(Number.MAX_SAFE_INTEGER + 1, 'JPY').ok).toBe(false);
  });

  it('通貨コードの形式を検証する', () => {
    expect(createMoney(100, 'jpy').ok).toBe(false);
    expect(createMoney(100, 'JPYY').ok).toBe(false);
    expect(createMoney(100, 'JPY').ok).toBe(true);
  });

  it('同一通貨の加算ができる', () => {
    const left = createMoney(1000, 'JPY');
    const right = createMoney(200, 'JPY');
    if (!left.ok || !right.ok) throw new Error('setup failed');
    const sum = addMoney(left.value, right.value);
    if (!sum.ok) throw new Error('expected success');
    expect(sum.value.amountMinor).toBe(1200);
  });

  it('異なる通貨の加算を拒否する（A-2）', () => {
    const jpy = createMoney(1000, 'JPY');
    const usd = createMoney(1000, 'USD');
    if (!jpy.ok || !usd.ok) throw new Error('setup failed');
    const sum = addMoney(jpy.value, usd.value);
    expect(sum.ok).toBe(false);
    if (sum.ok) throw new Error('expected failure');
    expect(sum.error.code).toBe('CURRENCY_MISMATCH');
  });

  it('減算で負になる場合を拒否する', () => {
    const small = createMoney(100, 'JPY');
    const large = createMoney(500, 'JPY');
    if (!small.ok || !large.ok) throw new Error('setup failed');
    expect(subtractMoney(small.value, large.value).ok).toBe(false);
  });

  it('数量との乗算で誤差が出ない', () => {
    const unit = createMoney(12345, 'JPY');
    if (!unit.ok) throw new Error('setup failed');
    const total = multiplyMoney(unit.value, 7);
    if (!total.ok) throw new Error('expected success');
    expect(total.value.amountMinor).toBe(86415);
  });
});

describe('Quantity', () => {
  it('1 以上を受け付ける', () => {
    expect(validateQuantity(1).ok).toBe(true);
  });

  it('0 と負数を拒否する', () => {
    expect(validateQuantity(0).ok).toBe(false);
    expect(validateQuantity(-3).ok).toBe(false);
  });

  it('小数を拒否する', () => {
    expect(validateQuantity(1.5).ok).toBe(false);
  });

  it('全体上限を超える数量を拒否する', () => {
    expect(validateQuantity(MAX_QUANTITY_PER_ORDER + 1).ok).toBe(false);
  });

  it('出品ごとの上限が全体上限より優先される', () => {
    expect(validateQuantity(2, 1).ok).toBe(false);
    expect(validateQuantity(1, 1).ok).toBe(true);
  });

  it('出品側の上限が全体上限より大きくても全体上限を超えられない', () => {
    expect(validateQuantity(MAX_QUANTITY_PER_ORDER + 1, 100_000).ok).toBe(false);
  });
});
