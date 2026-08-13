import { describe, expect, it } from 'vitest';
import {
  amountMinorSchema,
  currencySchema,
  idempotencyKeySchema,
  moneySchema,
  paginationSchema,
  quantitySchema,
  slugSchema,
  validate,
} from '../src/index';

describe('金額のスキーマ', () => {
  it('整数を受け付ける', () => {
    expect(amountMinorSchema.safeParse(12000).success).toBe(true);
  });

  it('小数を拒否する', () => {
    expect(amountMinorSchema.safeParse(120.5).success).toBe(false);
  });

  it('負数を拒否する', () => {
    expect(amountMinorSchema.safeParse(-1).success).toBe(false);
  });

  it('安全整数を超える値を拒否する', () => {
    expect(amountMinorSchema.safeParse(Number.MAX_SAFE_INTEGER + 2).success).toBe(false);
  });

  it('文字列の金額を拒否する（暗黙の型変換をしない）', () => {
    expect(amountMinorSchema.safeParse('12000').success).toBe(false);
  });
});

describe('通貨コード', () => {
  it.each(['JPY', 'USD'])('%s を受け付ける', (code) => {
    expect(currencySchema.safeParse(code).success).toBe(true);
  });

  it.each(['jpy', 'JPYY', 'JP', ''])('%s を拒否する', (code) => {
    expect(currencySchema.safeParse(code).success).toBe(false);
  });
});

describe('数量', () => {
  it('1 以上を受け付ける', () => {
    expect(quantitySchema.safeParse(1).success).toBe(true);
  });

  it('0・負数・小数を拒否する', () => {
    expect(quantitySchema.safeParse(0).success).toBe(false);
    expect(quantitySchema.safeParse(-1).success).toBe(false);
    expect(quantitySchema.safeParse(1.5).success).toBe(false);
  });
});

describe('slug', () => {
  it('英小文字・数字・ハイフンを受け付ける', () => {
    expect(slugSchema.safeParse('sengoku-artwork-01').success).toBe(true);
  });

  it('大文字・記号・連続ハイフンを拒否する', () => {
    expect(slugSchema.safeParse('Sengoku').success).toBe(false);
    expect(slugSchema.safeParse('a_b').success).toBe(false);
    expect(slugSchema.safeParse('a--b').success).toBe(false);
  });
});

describe('ページング', () => {
  it('limit の既定値が適用される', () => {
    const result = paginationSchema.safeParse({});
    if (!result.success) throw new Error('expected success');
    expect(result.data.limit).toBe(20);
  });

  it('limit の上限を超える値を拒否する', () => {
    expect(paginationSchema.safeParse({ limit: 1000 }).success).toBe(false);
  });
});

describe('冪等キー', () => {
  it('短すぎるキーを拒否する（推測されやすいため）', () => {
    expect(idempotencyKeySchema.safeParse('abc').success).toBe(false);
  });

  it('十分な長さのキーを受け付ける', () => {
    expect(idempotencyKeySchema.safeParse('01J8Z7Q4XXXXXXXXXXXXXXXXXX').success).toBe(true);
  });
});

describe('validate（エラーに入力値を含めない）', () => {
  it('成功時は値を返す', () => {
    const result = validate(moneySchema, { amount: 1000, currency: 'JPY' });
    if (!result.ok) throw new Error('expected success');
    expect(result.value.amount).toBe(1000);
  });

  it('失敗時はフィールド名と種別のみを返す', () => {
    const secret = 'sensitive-user-input-value';
    const result = validate(moneySchema, { amount: secret, currency: 'JPY' });
    if (result.ok) throw new Error('expected failure');

    expect(result.issues.map((issue) => issue.field)).toContain('amount');
    expect(JSON.stringify(result.issues)).not.toContain(secret);
  });
});
