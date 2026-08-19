import type { TokushohoFields } from './document';

/**
 * 購入の最終確認画面に出す事項（特定商取引法 第12条の6）。
 *
 * ⚠️ **「どこかに書いてある」では足りない。** 通信販売では、申込みの
 * **最終確認画面そのもの**に出す必要がある。特商法のページへのリンクを
 * 置くだけでは要件を満たさない。だからこの部品がある。
 *
 * ⚠️ **返品特約は特に重い。** 表示していないと、こちらの返品条件は
 * 効かず、法定の解除権（8日間）が適用される。「返品不可」と別の場所に
 * 書いていても、最終確認画面に出ていなければ主張できない。
 *
 * ⚠️ **掲げるものが無ければ売らせない。** 表示義務を果たせない状態での
 * 販売は、販売そのものが法に触れる。手数料率が 0 のときに支払い口を
 * 作らせないのと同じ考え方で、「売れない」ほうへ倒す。
 */

/**
 * 最終確認画面へ出す、特商法表記の項目。
 *
 * ⚠️ **12 項目すべてではない。** 事業者の名称や所在地は特商法のページで
 * 足りる。ここに並べるのは、**この申込みの条件**にあたるものだけ。
 * 全部載せると読む気を失い、いちばん大事な返品特約が埋もれる。
 *
 * 分量と販売価格は注文の側（数量・価格）から出すので、ここには含めない。
 */
export const CHECKOUT_NOTICE_FIELD_KEYS = [
  'additionalFees',
  'paymentMethods',
  'paymentTiming',
  'deliveryTiming',
  'returnPolicy',
] as const;

export type CheckoutNoticeFieldKey = (typeof CHECKOUT_NOTICE_FIELD_KEYS)[number];

export type CheckoutLegalNotice = Readonly<Record<CheckoutNoticeFieldKey, string>>;

/**
 * 特商法表記から、最終確認画面へ出す分だけを取り出す。
 *
 * ⚠️ **空欄があれば `null`。** 半端に出すと、出ている項目だけを見て
 * 「表示している」と思い込む。公開時に欠けを止めてあるので通常は
 * 起きないが、ここでも確かめる。判定を 1 か所に頼らない。
 */
export function checkoutNoticeFrom(fields: TokushohoFields | null): CheckoutLegalNotice | null {
  if (fields === null) {
    return null;
  }
  for (const key of CHECKOUT_NOTICE_FIELD_KEYS) {
    if (fields[key].trim() === '') {
      return null;
    }
  }
  const entries = CHECKOUT_NOTICE_FIELD_KEYS.map((key) => [key, fields[key]] as const);
  return Object.fromEntries(entries) as unknown as CheckoutLegalNotice;
}

/**
 * この申込みについて、表示義務を果たせるか。
 *
 * ⚠️ **`true` は「表示できる」であって「表示した」ではない。** 実際に
 * 画面へ出すのは表示層の仕事。ここは「出すものが揃っているか」だけを見る。
 */
export function canDiscloseCheckoutTerms(fields: TokushohoFields | null): boolean {
  return checkoutNoticeFrom(fields) !== null;
}
