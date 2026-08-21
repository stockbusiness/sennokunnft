import { describe, expect, it } from 'vitest';
import {
  CREATOR_COPY,
  creatorErrorMessage,
  earningsStateLabel,
  earningsStateTone,
  formatPeriodKey,
} from './creator-copy';

/**
 * 作家さま向けの文言（実運営 指示書 P1-2）。
 *
 * ⚠️ **この組の主題は「読んだ方が誤解しないこと」。** 数字が合っている
 * ことは API 側のテストが見る。ここは**言葉が何を約束してしまうか**を見る。
 */

describe('締めの状態の言葉', () => {
  /*
    ⚠️ **見込みを「確定」と読ませない。** 締めるまでは動く。
       同じ顔で出すと、あとで減ったときに「話が違う」になる。
  */
  it('見込みと確定を、別の言葉で出す', () => {
    expect(earningsStateLabel('estimate')).toBe('見込み');
    expect(earningsStateLabel('confirmed')).not.toBe(earningsStateLabel('estimate'));
  });

  it('お振込み済みだけを、済んだ色にする', () => {
    expect(earningsStateTone('paid')).toBe('success');
    expect(earningsStateTone('estimate')).toBe('neutral');
    expect(earningsStateTone('draft')).toBe('neutral');
    // ⚠️ 「お支払い予定」はまだ振り込んでいない。済んだ顔にしない。
    expect(earningsStateTone('confirmed')).toBe('neutral');
  });

  /*
    ⚠️ **`paid` を「入金されました」と書かない。** こちらの記録であって、
       着金の確認ではない。実際に届いたかを機械は確かめられない。
  */
  it('お振込み済みを、着金の確認として書かない', () => {
    expect(earningsStateLabel('paid')).toBe('お振込み済み');
    expect(earningsStateLabel('paid')).not.toContain('入金');
  });
});

describe('対象の月の表記', () => {
  it('人が読む形にする', () => {
    expect(formatPeriodKey('2026-08')).toBe('2026年8月');
    expect(formatPeriodKey('2026-01')).toBe('2026年1月');
  });

  /*
    ⚠️ **読めない値を勝手に置き換えない。** 「どの月か分からない」より
       「別の月に見える」ほうが悪い。
  */
  it.each([['2026/08'], ['2026-8'], [''], ['来月']])('読めない値はそのまま返す（%s）', (value) => {
    expect(formatPeriodKey(value)).toBe(value);
  });
});

describe('お知らせの言葉', () => {
  /*
    ⚠️ **「値上がり」「利益」「投資」を書かない**（販売の性質を誤らせる）。
       文言をまとめて見張る。1 つ足すたびに人が見直すのは続かない。
  */
  it.each(['値上がり', '利益', '投資', '儲か', '資産価値'])(
    '販売の性質を誤らせる言葉を含まない（%s）',
    (forbidden) => {
      const all = Object.values(CREATOR_COPY).join('\n');
      expect(all).not.toContain(forbidden);
    },
  );

  /*
    ⚠️ **Web3 用語を出さない。** 出品する方にも、暗号資産の知識を
       前提にしない。
  */
  it.each(['NFT', 'ミント', 'ウォレット', 'ブロックチェーン', 'トークン'])(
    'Web3 用語を含まない（%s）',
    (jargon) => {
      const all = Object.values(CREATOR_COPY).join('\n');
      expect(all).not.toContain(jargon);
    },
  );

  /*
    ⚠️ **0 円の振込予定を「ありません」で終わらせない。** 繰り越される
       ことまで書かないと、「消えた」と読まれる。
  */
  it('お振込が無いときに、繰り越されることを書く', () => {
    expect(CREATOR_COPY.earningsNoNextPayoutHint).toContain('繰り越');
  });

  /*
    ⚠️ **お振込先は「未登録」で終わらせない**（P1-3）。探しても見つからない。
       まだ用意できていないと、こちらから言う。
  */
  /*
    ⚠️ **「確認します」と書かない**（`UD-124` 決定 2026-08-21）。こちらが
       確かめられるのは形だけで、口座が実在するかは振込を試みたときに
       初めて分かる。書くと、間違えて登録した方が「確認されたはず」と思う。
  */
  it('お振込先を「確認する」と書かない', () => {
    const all = Object.values(CREATOR_COPY).join('\n');
    expect(all).not.toContain('確認いたします');
    expect(CREATOR_COPY.payoutAccountDescription).not.toContain('確認');
  });

  /*
    ⚠️ **口座名義がカナであることを、はっきり書く。** ここがいちばん詰まる。
  */
  it('口座名義はカタカナだと、はっきり書く', () => {
    expect(CREATOR_COPY.fieldAccountHolderHint).toContain('カタカナ');
    expect(CREATOR_COPY.fieldAccountHolderHint).toContain('漢字');
  });

  /*
    ⚠️ **桁数を書かない。** 金融機関によって違う。「7桁」と書くと、違う方が
       「間違っているのでは」と手を止める。
  */
  it('口座番号の桁数を書かない', () => {
    expect(CREATOR_COPY.fieldAccountNumberHint).not.toContain('桁');
  });

  /*
    ⚠️ **変えたら知らせが飛ぶことを、押す前に伝える。** あとから届くと、
       身に覚えのない知らせに見える。
  */
  it('変更するとお知らせが届くことを、先に伝える', () => {
    expect(CREATOR_COPY.payoutAccountChangeHint).toContain('お知らせが届きます');
  });

  /*
    ⚠️ **インボイス登録番号を「無いと売れない」と読ませない。**
       免税事業者の方もいらっしゃる。
  */
  it('インボイス登録番号が任意だと分かる', () => {
    expect(CREATOR_COPY.fieldInvoiceNumberHint).toContain('任意');
    expect(CREATOR_COPY.fieldInvoiceNumberHint).toContain('登録がなくても販売できます');
  });

  /*
    ⚠️ **CSV に買った方の情報が入らないことを、こちらから言う。**
       聞かれる前に書くほうが、余計なご心配をかけずに済む。
  */
  it('CSV に買った方の情報が入らないと書く', () => {
    expect(CREATOR_COPY.earningsCsvHint).toContain('含まれません');
  });
});

describe('失敗の言葉', () => {
  /*
    ⚠️ **どの項目がどう悪かったかを断定しない。** 検証の中身を写すと、
       判定の詳細が外へ出る。直しに行ける場所だけを伝える。
  */
  it('お店の情報が断られたら、直す場所を伝える', () => {
    const message = creatorErrorMessage('rejected', 'CREATOR_PROFILE_INVALID');
    expect(message).toContain('https://');
    expect(message).toContain('インボイス登録番号');
  });

  it('符号が分からなくても、何か言う', () => {
    expect(creatorErrorMessage('unavailable')).not.toBe('');
    expect(creatorErrorMessage('unauthorized')).not.toBe('');
  });
});
