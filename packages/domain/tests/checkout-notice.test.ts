import { describe, expect, it } from 'vitest';
import {
  CHECKOUT_NOTICE_FIELD_KEYS,
  TOKUSHOHO_FIELD_KEYS,
  canDiscloseCheckoutTerms,
  checkoutNoticeFrom,
  type TokushohoFields,
} from '../src/index';

function filled(overrides: Partial<TokushohoFields> = {}): TokushohoFields {
  const base = Object.fromEntries(
    TOKUSHOHO_FIELD_KEYS.map((key) => [key, `値: ${key}`]),
  ) as unknown as TokushohoFields;
  return { ...base, ...overrides };
}

describe('最終確認画面に出す事項（特商法12条の6）', () => {
  /*
    ⚠️ **12 項目すべてを並べない。** 事業者の名称や所在地は特商法の
       ページで足りる。全部載せると読む気を失い、いちばん大事な
       返品特約が埋もれる。
  */
  it('この申込みの条件にあたる 5 項目だけを出す', () => {
    expect([...CHECKOUT_NOTICE_FIELD_KEYS]).toEqual([
      'additionalFees',
      'paymentMethods',
      'paymentTiming',
      'deliveryTiming',
      'returnPolicy',
    ]);
  });

  it('事業者の名称や所在地は含めない', () => {
    const notice = checkoutNoticeFrom(filled());
    expect(notice).not.toBeNull();
    expect(Object.keys(notice ?? {})).not.toContain('sellerName');
    expect(Object.keys(notice ?? {})).not.toContain('address');
  });

  it('揃っていれば取り出せる', () => {
    expect(checkoutNoticeFrom(filled())).toEqual({
      additionalFees: '値: additionalFees',
      paymentMethods: '値: paymentMethods',
      paymentTiming: '値: paymentTiming',
      deliveryTiming: '値: deliveryTiming',
      returnPolicy: '値: returnPolicy',
    });
  });

  /*
    ⚠️ **返品特約は特に重い。** 表示していないと、こちらの返品条件は
       効かず、法定の解除権が適用される。別の場所に書いてあっても、
       最終確認画面に出ていなければ主張できない。
  */
  it('返品特約が空欄なら出せない', () => {
    expect(checkoutNoticeFrom(filled({ returnPolicy: '' }))).toBeNull();
    expect(canDiscloseCheckoutTerms(filled({ returnPolicy: '   ' }))).toBe(false);
  });

  for (const key of CHECKOUT_NOTICE_FIELD_KEYS) {
    it(`${key} が空欄なら出せない（半端に出さない）`, () => {
      expect(canDiscloseCheckoutTerms(filled({ [key]: '' }))).toBe(false);
    });
  }

  it('表記そのものが無ければ出せない', () => {
    expect(checkoutNoticeFrom(null)).toBeNull();
    expect(canDiscloseCheckoutTerms(null)).toBe(false);
  });

  /*
    ⚠️ 最終確認画面に出さない項目が空でも、こちらは出せる。
       事業者の名称などは特商法のページ側の話で、公開時に別途止めている。
  */
  it('最終確認画面に出さない項目の欠けでは止めない', () => {
    expect(canDiscloseCheckoutTerms(filled({ operatingEnvironment: '' }))).toBe(true);
  });
});
