import { domainError, type DomainError } from '../shared/errors';
import { err, ok, type Result } from '../shared/result';

/**
 * 作家さまの表示名（決定 2026-08-20）。
 *
 * **屋号・ペンネームを許す。重複は許さない。**
 *
 * ⚠️ **重複の判定は「見た目」で行う。** 生の文字列だけを比べると、
 * 全角と半角、大文字と小文字、前後の空白、見えない文字を混ぜるだけで
 * **同じに見える別の名前**を作れてしまう。買う人には見分けが付かないので、
 * 実質のなりすましになる。**正規化した鍵で UNIQUE を張る。**
 *
 * ⚠️ **表示は入力されたまま。** 正規化するのは重複判定の鍵だけで、
 * 画面には打ったとおりに出す。正規化した形を表示すると、
 * 「打った名前と違う」と言われる。
 */

export const DISPLAY_NAME_MIN_LENGTH = 1;
/**
 * 上限。
 *
 * ⚠️ **短めにしてある。** 作品ページの見出しの隣に出るので、長いと
 * 作品名を押し出す。長い肩書きは説明文に書いていただく。
 */
export const DISPLAY_NAME_MAX_LENGTH = 40;

/**
 * 名乗らせない語。
 *
 * ⚠️ **なりすましを止めるためであって、言葉狩りではない。** 買う人が
 * 「この出品は運営がやっている」と誤解する名前だけを断る。
 *
 * ⚠️ **部分一致で見る。** 「千ノ国NFTマーケット公式」のように、
 * 前後に足して名乗られるのがいちばん多い形である。
 *
 * ⚠️ **ここを増やしすぎない。** 増やすほど、普通の名前が通らなくなる。
 * 迷ったら通して、問題が起きてから運営が個別に対応するほうがよい——
 * **通らない名前は本人にはどうにもできない**が、あとから直すことはできる。
 */
const RESERVED_FRAGMENTS = ['運営', '公式', '事務局', 'admin', 'administrator', 'official'];

/**
 * 表示名として受け付けられない文字。
 *
 * ⚠️ **制御文字と、幅を持たない文字を弾く。** 見えない文字を混ぜると、
 * 正規化しても消えないまま「同じに見える別の名前」を作れる。
 * 具体的には、制御文字（`U+0000`〜`U+001F`・`U+007F`）、ゼロ幅の文字
 * （`U+200B`〜`U+200F`）、書字方向の上書き（`U+202A`〜`U+202E`）、
 * 不可視の区切り（`U+2060`〜`U+206F`）、`U+FEFF`。
 */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/u;

/** 検証を通った表示名。⚠️ 表示用と重複判定用の 2 つを持つ。 */
export interface ValidatedDisplayName {
  /** 画面に出す値。⚠️ 打たれたまま（前後の空白だけ落とす）。 */
  readonly value: string;
  /**
   * 重複判定の鍵。
   *
   * ⚠️ **これに UNIQUE を張る。** 生の値ではない。生の値で張ると、
   * 全角・半角や大文字・小文字を変えるだけで同じ名前を名乗れる。
   */
  readonly key: string;
}

/**
 * 表示名を検証し、重複判定の鍵を作る。
 *
 * ⚠️ **「すでに使われているか」はここで見ない。** DB の UNIQUE が決める。
 * ここで先に問い合わせて判定すると、同時に登録した 2 人が両方通る。
 */
export function validateDisplayName(input: string): Result<ValidatedDisplayName, DomainError> {
  const value = input.trim();

  if (value.length < DISPLAY_NAME_MIN_LENGTH) {
    return err(domainError('DISPLAY_NAME_INVALID', 'display name is empty'));
  }
  if (value.length > DISPLAY_NAME_MAX_LENGTH) {
    return err(domainError('DISPLAY_NAME_INVALID', 'display name is too long'));
  }
  if (FORBIDDEN_CHARS.test(value)) {
    // ⚠️ 見えない文字。同じに見える別の名前を作られる。
    return err(domainError('DISPLAY_NAME_INVALID', 'display name has forbidden characters'));
  }

  const key = displayNameKey(value);
  if (key.length === 0) {
    // 空白だけ、など。⚠️ 鍵が空だと UNIQUE が働かない。
    return err(domainError('DISPLAY_NAME_INVALID', 'display name has no comparable content'));
  }

  if (RESERVED_FRAGMENTS.some((fragment) => key.includes(fragment))) {
    /*
      ⚠️ **理由を分けて返す。** 「使われています」と同じ符号にすると、
         本人は何度も別の名前を試すことになる。直し方が違う。
    */
    return err(domainError('DISPLAY_NAME_RESERVED', 'display name impersonates the operator'));
  }

  return ok({ value, key });
}

/**
 * 重複判定の鍵を作る。
 *
 * ⚠️ **`NFKC` で正規化する。** 全角の「Ａ」と半角の「A」、合成済みの
 * 文字と分解された文字などを同じ形へそろえる。そろえないと、見た目が
 * 同じ名前をいくつでも作れる。
 *
 * ⚠️ **小文字へそろえる。** 「Taro」と「TARO」を別人にしない。
 *
 * ⚠️ **空白をすべて落とす。** 「戦国 太郎」と「戦国太郎」を別人にしない。
 * 空白の有無は、買う人には区別が付かない。
 */
export function displayNameKey(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
}
