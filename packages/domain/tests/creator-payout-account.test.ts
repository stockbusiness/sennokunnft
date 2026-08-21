import { describe, expect, it } from 'vitest';
import { maskAccountNumber, payoutAccountTypeLabel, validatePayoutAccount } from '../src';

/**
 * お振込先（P1-3・`UD-124` 決定 2026-08-21）。
 *
 * ⚠️ **この組の主題は 3 つ。**
 *  1. **通帳を見ながら打てること**——空白やハイフンで弾かない
 *  2. **登録できない方を作らないこと**——桁数を固定しない
 *  3. **伏せた表記から元へ戻せないこと**
 */

const VALID = {
  bankName: '千ノ国銀行',
  branchName: '本店',
  accountType: 'ordinary' as const,
  accountNumber: '1234567',
  accountHolderKana: 'センゴク タロウ',
};

describe('受け付けてよい内容か', () => {
  it('ふつうの口座は通る', () => {
    const result = validatePayoutAccount(VALID);
    expect(result.ok).toBe(true);
  });

  /*
    ⚠️ **通帳の表記をそのまま写せるようにする。** 空白やハイフンで断ると、
       見た目には正しいのに弾かれて、理由が画面から分からない。
  */
  it.each([
    ['123-4567'],
    ['123 4567'],
    ['１２３４５６７'.replace(/[０-９]/gu, (d) => String('０１２３４５６７８９'.indexOf(d)))],
  ])('番号の空白とハイフンは落として受ける（%s）', (accountNumber) => {
    const result = validatePayoutAccount({ ...VALID, accountNumber });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.accountNumber).toBe('1234567');
    }
  });

  /*
    ⚠️ **7 桁に固定しない。** ゆうちょ銀行や一部の金融機関で桁数が違う。
       固定すると、その方だけ登録できないまま詰まる。
  */
  it.each([['1'], ['12345'], ['1234567890']])('桁数を固定しない（%s）', (accountNumber) => {
    expect(validatePayoutAccount({ ...VALID, accountNumber }).ok).toBe(true);
  });

  it.each([['12345678901'], ['abcdefg'], ['']])(
    '数字でない・長すぎる番号は断る（%s）',
    (accountNumber) => {
      expect(validatePayoutAccount({ ...VALID, accountNumber }).ok).toBe(false);
    },
  );

  /*
    ⚠️ **漢字は通さない。** 口座名義はカナで登録されているので、漢字だと
       照合できない。ただし**断る理由は画面で伝える**（ここは形だけ見る）。
  */
  it('漢字の名義は断る', () => {
    expect(validatePayoutAccount({ ...VALID, accountHolderKana: '戦国 太郎' }).ok).toBe(false);
  });

  /*
    ⚠️ **半角カナを強いない。** 振込の依頼書は半角カナだが、それは送る側で
       変換する話で、打つ方に強いる理由が無い。
  */
  it.each([['センゴク タロウ'], ['ｾﾝｺﾞｸ ﾀﾛｳ'], ['SENGOKU TARO'], ['センゴク（カ']])(
    '全角カナ・半角カナ・英字・カッコを通す（%s）',
    (accountHolderKana) => {
      expect(validatePayoutAccount({ ...VALID, accountHolderKana }).ok).toBe(true);
    },
  );

  it('前後の空白は落とす', () => {
    const result = validatePayoutAccount({ ...VALID, bankName: '  千ノ国銀行  ' });
    expect(result.ok && result.value.bankName).toBe('千ノ国銀行');
  });

  it.each([['bankName'], ['branchName']])('空の %s は断る', (field) => {
    expect(validatePayoutAccount({ ...VALID, [field]: '   ' }).ok).toBe(false);
  });
});

describe('伏せた表記', () => {
  /*
    ⚠️ **末尾 4 桁だけ残す。** 残さないと、運営が「どの口座の話か」を本人と
       確かめられない。残しすぎると、伏せる意味が無い。
  */
  it('末尾 4 桁だけ残す', () => {
    expect(maskAccountNumber('1234567')).toBe('***4567');
  });

  it('短い番号でも、伏せてあることが見て分かる', () => {
    expect(maskAccountNumber('12')).toBe('***12');
  });

  /*
    ⚠️ **元へは戻せない。** 伏せた表記を振込に使えると読ませない。
  */
  it('元の番号は残らない', () => {
    const masked = maskAccountNumber('987654321');
    expect(masked).not.toContain('98765');
  });

  it('検証の結果にも伏せた表記が入る', () => {
    const result = validatePayoutAccount(VALID);
    expect(result.ok && result.value.maskedAccountNumber).toBe('***4567');
  });
});

describe('種別の呼び名', () => {
  // ⚠️ 通帳の表記に合わせる。「普通預金」ではなく「普通」。
  it('通帳の表記に合わせる', () => {
    expect(payoutAccountTypeLabel('ordinary')).toBe('普通');
    expect(payoutAccountTypeLabel('checking')).toBe('当座');
  });
});
