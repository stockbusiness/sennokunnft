import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_COPY,
  accountStatusLabel,
  attentionTone,
  duplicateSignalLabel,
  emailChangeStatusLabel,
  emailChangeStatusTone,
  formatJst,
  formatYen,
  refundReasonLabel,
  shortId,
  verificationMethodLabel,
} from './customer-copy';

/**
 * 顧客サポートの言葉（P1-1）。
 *
 * ⚠️ **「同一人物」と書かない。** 重複は候補であって、確定していない。
 * 読み違えたまま判断されると、他人の持ち物を渡すことになる。
 */

describe('重複候補の言葉', () => {
  /*
    ⚠️ **この試験が文言の歯止め。** 「同一人物」「統合」と書き換えられたら
       落ちる。落ちたときは、書き換える前にここのコメントを読むことになる。
  */
  it('「同一人物」と断定しない', () => {
    expect(CUSTOMER_COPY.duplicatesHint).not.toContain('同一人物');
    expect(CUSTOMER_COPY.duplicatesHint).toContain('とは限りません');
  });

  it('この画面から統合できないことを書く', () => {
    expect(CUSTOMER_COPY.duplicatesHint).toContain('統合することはできません');
  });

  it('手がかりを日本語にする', () => {
    expect(duplicateSignalLabel('email_hash')).toBe('ご連絡先が一致');
    expect(duplicateSignalLabel('common_user_id')).toBe('共通顧客IDが一致');
  });
});

describe('ご連絡先の変更', () => {
  /*
    ⚠️ **ここでアドレスが変わらないことを、画面にも書く。** 書かないと、
       押した運営が「変わったはず」と思って応対してしまう。
  */
  it('この画面では変わらないことを書く', () => {
    expect(CUSTOMER_COPY.emailChangeHint).toContain('変わりません');
  });

  /*
    ⚠️ **「本人確認済み」を「変更済み」と読ませない。** 本人確認は
       変更ではない。取り違えると、変え忘れたまま応対が終わる。
  */
  it('本人確認済みは「未変更」と明示する', () => {
    expect(emailChangeStatusLabel('identity_verified')).toContain('未変更');
    expect(emailChangeStatusLabel('completed')).toBe('変更済み');
  });

  it('状態の色は、済んだものだけ緑', () => {
    expect(emailChangeStatusTone('completed')).toBe('success');
    expect(emailChangeStatusTone('requested')).not.toBe('success');
  });

  /*
    ⚠️ **何をしたのかが、あとから読んで分かる言葉にする。**
  */
  it('本人確認の方法を、行為として書く', () => {
    expect(verificationMethodLabel('order_details_match')).toBe('ご注文の内容を照合した');
    expect(verificationMethodLabel('identity_document')).toContain('保存していません');
    expect(verificationMethodLabel(null)).toBe('—');
  });
});

describe('応対の前に知っておくべきことの色', () => {
  /*
    ⚠️ **停止中だけが赤。** ログインできない・買えないという
       お問い合わせの答えが、ここにある。
  */
  it('停止中だけが赤', () => {
    expect(attentionTone('account_suspended')).toBe('danger');
    expect(attentionTone('unclaimed_entitlements')).not.toBe('danger');
    expect(attentionTone('wallet_delivery_stalled')).not.toBe('danger');
    expect(attentionTone('refund_in_progress')).not.toBe('danger');
  });
});

describe('表示', () => {
  it('アカウントの状態を日本語にする', () => {
    expect(accountStatusLabel('active')).toBe('ご利用中');
    expect(accountStatusLabel('suspended')).toBe('停止中');
  });

  it('返金の理由を日本語にする', () => {
    expect(refundReasonLabel('buyer_request')).toBe('お客さまのご希望');
    // ⚠️ 知らない値は握り潰さずそのまま出す（消えるより気づける）。
    expect(refundReasonLabel('brand_new_reason')).toBe('brand_new_reason');
  });

  it('金額は桁区切りの円', () => {
    expect(formatYen(24_000)).toBe('24,000 円');
    // ⚠️ 負を隠さない。返金が支払いを超えるのは記録の食い違い。
    expect(formatYen(-2_000)).toBe('-2,000 円');
  });

  it('日時は JST', () => {
    expect(formatJst('2026-08-21T00:30:00.000Z')).toBe('2026/08/21 09:30');
    expect(formatJst(null)).toBe('—');
    expect(formatJst('これは日時ではない')).toBe('—');
  });

  it('アカウントIDは見分けがつく範囲だけ', () => {
    expect(shortId('aa11bb22-0000-4000-8000-000000000001')).toBe('aa11bb22');
  });
});

describe('画面の注意書き', () => {
  /*
    ⚠️ **消せないことを、書く前に伝える。** 書いたあとに知らされても遅い。
  */
  it('申し送りが消せないことを書く', () => {
    expect(CUSTOMER_COPY.notesHint).toContain('消せません');
  });

  it('アドレスそのものが保存されないことを書く', () => {
    expect(CUSTOMER_COPY.searchHint).toContain('保存も表示もされません');
  });

  /*
    ⚠️ **持っていないものを「準備中」と言わない。** 代理店連携は
       契約待ちで、いつ入るかも決まっていない。
  */
  it('代理店・紹介元が無いことを書く', () => {
    expect(CUSTOMER_COPY.referralUnavailable).toContain('まだこの仕組みにありません');
  });
});
