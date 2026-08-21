import { describe, expect, it } from 'vitest';
import {
  CREATOR_DIRECTORY_COPY,
  SALES_REPORT_COPY,
  creatorSalesTermsLabel,
  formatSignedYen,
  salesRowIsEmpty,
} from './reporting-copy';

/**
 * 運営の売上と作家さまの一覧の文言（`UD-123` / `UD-124` の一部）。
 *
 * ⚠️ **この組が見張るのは、数字の読み違いを招く言い回しである。**
 * 「入金額」と読ませないこと、消費税の欄を作らないこと、そして
 * **お振込先の値がこの画面に出ないと伝えること**。
 */
describe('売上の言い回し', () => {
  /*
    ⚠️ **「入金額」と書かない。** 決済事業者の手数料を引く前の値である。
       名前を間違えると、合わない額の原因を探す先を間違える。
  */
  it('入金額と読ませない', () => {
    expect(SALES_REPORT_COPY.notInflowWarning).toContain('入金額ではありません');
    expect(SALES_REPORT_COPY.notInflowHint).toContain('手数料を引く前');
    expect(SALES_REPORT_COPY.columnNet).toBe('差引');
    expect(SALES_REPORT_COPY.columnNet).not.toContain('入金');
  });

  /*
    ⚠️ **消費税の欄を作らない**（`UD-401` 未決）。空欄はいつか埋められる。
  */
  it('消費税の欄を作らず、出していない理由を書く', () => {
    const columns = [
      SALES_REPORT_COPY.columnGross,
      SALES_REPORT_COPY.columnFee,
      SALES_REPORT_COPY.columnCreator,
      SALES_REPORT_COPY.columnRefunded,
      SALES_REPORT_COPY.columnNet,
    ].join(',');
    expect(columns).not.toContain('消費税');
    expect(SALES_REPORT_COPY.taxHint).toContain('内訳');
  });

  /*
    ⚠️ **売上と返金で数える日が違うことを書く。** 書かないと
       「返金した日の売上がマイナス」と読まれる。
  */
  it('返金を数える日が違うことを伝える', () => {
    expect(SALES_REPORT_COPY.refundDayHint).toContain('返金が成立した日');
    expect(SALES_REPORT_COPY.refundDayHint).toContain('売れた日ではありません');
  });

  /** ⚠️ マイナスを隠さない。返金が上回る期間はマイナスになる。 */
  it('マイナスを隠さない', () => {
    expect(formatSignedYen(-8600)).toBe('−8,600 円');
    expect(formatSignedYen(12000)).toBe('12,000 円');
    expect(formatSignedYen(0)).toBe('0 円');
  });

  it('動きの無い期間を見分けられる', () => {
    const base = {
      periodKey: '2026-08-20',
      grossAmount: 0,
      platformFeeAmount: 0,
      creatorAmount: 0,
      refundedAmount: 0,
      netAmount: 0,
    };
    expect(salesRowIsEmpty({ ...base, orderCount: 0, refundCount: 0 })).toBe(true);
    expect(salesRowIsEmpty({ ...base, orderCount: 0, refundCount: 1 })).toBe(false);
  });
});

describe('作家さまの一覧の言い回し', () => {
  /*
    ⚠️ **お振込先の値がこの画面に出ないことを、はっきり書く。** 書かないと
       「どこかにあるはず」と探される。
  */
  it('お振込先の値はこの画面に出ないと伝える', () => {
    expect(CREATOR_DIRECTORY_COPY.payoutAccountHint).toContain('この画面には出ません');
    expect(CREATOR_DIRECTORY_COPY.payoutAccountHint).toContain('精算の画面');
  });

  /*
    ⚠️ **止める口が無いことを、画面で伝える。** 「探しても無い」と思われる
       より、「無い」と書いてあるほうが早い。
  */
  it('出品を止める口が無いと伝える', () => {
    expect(CREATOR_DIRECTORY_COPY.noSuspendNotice).toContain('止めることはできません');
    expect(CREATOR_DIRECTORY_COPY.noSuspendHint).toContain('作品ごとに公開を止めて');
  });

  /*
    ⚠️ **インボイス番号を「確認済み」と書かない。** 形しか確かめていない。
       実在は国税庁の公表サイトでしか分からない。
  */
  it('インボイス番号を確認済みと書かない', () => {
    expect(CREATOR_DIRECTORY_COPY.invoiceHint).toContain('形だけ');
    expect(CREATOR_DIRECTORY_COPY.invoiceHint).not.toContain('確認済み');
  });

  /** ⚠️ `null` は「まだ」であって「不明」ではない。 */
  it('販売規約の同意を、未同意と同意済みで言い分ける', () => {
    const base = {
      accountId: 'a',
      displayName: null,
      shopName: null,
      status: 'active',
      artworkCount: 0,
      activeListingCount: 0,
      orderCount: 0,
      grossAmount: 0,
      refundedAmount: 0,
      lastSoldAt: null,
      hasPayoutAccount: false,
    };
    expect(creatorSalesTermsLabel({ ...base, salesTermsAcceptedAt: null })).toBe('未同意');
    expect(
      creatorSalesTermsLabel({ ...base, salesTermsAcceptedAt: '2026-08-01T00:00:00.000Z' }),
    ).toBe('同意済み');
  });

  it('お名前が無い方を、空欄のままにしない', () => {
    expect(CREATOR_DIRECTORY_COPY.noName).toContain('お名前の登録がありません');
  });
});
