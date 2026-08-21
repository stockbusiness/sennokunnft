import { err, ok, type Result } from '../shared/result';
import type { DomainErrorCode } from '../shared/errors';

/**
 * 作家さまのお振込先（P1-3・`UD-124` 決定 2026-08-21）。
 *
 * ⚠️ **本人確認書類は取らない。** 口座情報の確認をもって足りるとする決定
 * （`UD-124`）。**書類の画像もマイナンバーも、この仕組みは持たない。**
 * 持たないと決めたものは、列そのものを作らない——列があると、いつか誰かが
 * 入れる。
 *
 * ⚠️ **口座番号は「秘密」ではなく「個人情報」。** これだけでお金を引き
 * 出せるものではないが、漏れれば本人へ届く手掛かりになる。**保管中は
 * 包んでおき、画面には伏せた表記を出す。**
 *
 * ⚠️ **お振込先が変わることは、お金の行き先が変わること。** 乗っ取られた
 * 側から見れば、いちばん実入りのある操作である。変更は必ず記録し、
 * **ご本人へ知らせる**（気づけるのは本人だけ）。
 */

/** 預金の種別。⚠️ 自由文にしない（振込の依頼書に載る値である）。 */
export const PAYOUT_ACCOUNT_TYPES = ['ordinary', 'checking'] as const;
export type PayoutAccountType = (typeof PAYOUT_ACCOUNT_TYPES)[number];

export const BANK_NAME_MAX = 60;
export const BRANCH_NAME_MAX = 60;
export const ACCOUNT_HOLDER_MAX = 60;

/**
 * 口座番号の形。
 *
 * ⚠️ **7 桁固定にしない。** ゆうちょ銀行や一部の金融機関で桁数が違う。
 * 固定にすると、その方だけ登録できない——**理由が画面から分からないまま**
 * 詰まる。
 */
const ACCOUNT_NUMBER_PATTERN = /^\d{1,10}$/;

/**
 * 名義の形。
 *
 * ⚠️ **半角カタカナを求めない。** 振込の依頼書は半角カナだが、それは
 * 送る側で変換する話で、**打つ方に強いる理由が無い**。全角カナ・スペース・
 * 長音・記号（カッコ・ハイフン）まで通す。
 *
 * ⚠️ **漢字は通さない。** 口座名義はカナで登録されているので、漢字で
 * 入れられると照合できない。断る理由を画面で伝える。
 */
const ACCOUNT_HOLDER_PATTERN = /^[ァ-ヶーｦ-ﾟA-Za-z0-9()（）.\-\s]+$/u;

export interface PayoutAccountInput {
  readonly bankName: string;
  readonly branchName: string;
  readonly accountType: PayoutAccountType;
  readonly accountNumber: string;
  readonly accountHolderKana: string;
}

export interface ValidatedPayoutAccount {
  readonly bankName: string;
  readonly branchName: string;
  readonly accountType: PayoutAccountType;
  /** ⚠️ **包む前の値。** これを持ち回るのは、保存の直前までにする。 */
  readonly accountNumber: string;
  readonly accountHolderKana: string;
  /** 画面用。⚠️ **ここから元へは戻せない。** */
  readonly maskedAccountNumber: string;
}

/**
 * 登録してよい内容か。
 *
 * ⚠️ **「口座があるか」までは確かめられない。** 確かめられるのは形だけで、
 * 実在の確認は振込を試みたときに初めて分かる。**形が通ったことを
 * 「確認できた」と読ませない**（画面の文言も同じ考え方で書く）。
 */
export function validatePayoutAccount(
  input: PayoutAccountInput,
): Result<ValidatedPayoutAccount, { readonly code: DomainErrorCode }> {
  const bankName = input.bankName.trim();
  const branchName = input.branchName.trim();
  const accountHolderKana = input.accountHolderKana.trim();
  /*
    ⚠️ **番号からは空白とハイフンを落とす。** 通帳の表記を写すと入る。
       落とさずに断ると、見た目には正しいのに弾かれて理由が分からない。
  */
  const accountNumber = input.accountNumber.replace(/[\s\-\u{FF0D}\u{30FC}]/gu, '');

  if (bankName.length === 0 || bankName.length > BANK_NAME_MAX) {
    return err({ code: 'PAYOUT_ACCOUNT_INVALID' });
  }
  if (branchName.length === 0 || branchName.length > BRANCH_NAME_MAX) {
    return err({ code: 'PAYOUT_ACCOUNT_INVALID' });
  }
  if (!ACCOUNT_NUMBER_PATTERN.test(accountNumber)) {
    return err({ code: 'PAYOUT_ACCOUNT_INVALID' });
  }
  if (
    accountHolderKana.length === 0 ||
    accountHolderKana.length > ACCOUNT_HOLDER_MAX ||
    !ACCOUNT_HOLDER_PATTERN.test(accountHolderKana)
  ) {
    return err({ code: 'PAYOUT_ACCOUNT_INVALID' });
  }

  return ok({
    bankName,
    branchName,
    accountType: input.accountType,
    accountNumber,
    accountHolderKana,
    maskedAccountNumber: maskAccountNumber(accountNumber),
  });
}

/**
 * 口座番号を伏せる。`1234567` → `***4567`
 *
 * ⚠️ **末尾 4 桁だけ残す。** 残さないと、運営が「どの口座の話か」を
 * 本人と確かめられない。残しすぎると、伏せる意味が無い。
 *
 * ⚠️ **長さは元のまま残さない。** 桁数も手掛かりになる……とまでは言えないが、
 * 4 桁未満の番号でも `***` を先頭に付け、**伏せてあることが見て分かる**形にする。
 */
export function maskAccountNumber(accountNumber: string): string {
  const tail = accountNumber.slice(-4);
  return `***${tail}`;
}

export function isPayoutAccountType(value: string): value is PayoutAccountType {
  return (PAYOUT_ACCOUNT_TYPES as readonly string[]).includes(value);
}

/** 画面に出す種別の呼び名。⚠️ 通帳の表記に合わせる。 */
export function payoutAccountTypeLabel(type: PayoutAccountType): string {
  return type === 'ordinary' ? '普通' : '当座';
}
