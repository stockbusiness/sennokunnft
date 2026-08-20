import { domainError, type DomainError } from '../shared/errors';
import { err, ok, type Result } from '../shared/result';

/**
 * 対応メモ（`UD-121`）。
 *
 * 「誰がどう対応したか」が残らないと、同じ問い合わせに 2 人が別々の
 * 答えを返す。返金すると言った人と、できないと言った人が、同じ日に
 * 同じ方へ答える。
 *
 * ⚠️ **追記のみ。** 直す口も消す口も作らない。あとから書き換えられる
 * 記録は、揉めたときに何の役にも立たない。書き間違えたら、
 * 訂正のメモを足す。
 *
 * ⚠️ **注文の状態を変えない。** メモは記録であって操作ではない。
 */

export const ORDER_NOTE_MAX_LENGTH = 2000;

/**
 * 平文のメールアドレスらしき並び。
 *
 * ⚠️ **厳密なアドレスの検査ではない。** ここでやりたいのは
 * 「メールアドレスを書き写そうとしている」を捕まえることで、
 * 規格に合うかどうかの判定ではない。取りこぼしより、
 * 拾いすぎるほうがまだ良い。
 */
const EMAIL_LIKE = /[^\s@]+@[^\s@]+\.[^\s@]+/u;

/**
 * 制御文字。⚠️ 改行（`\n`）とタブ（`\t`）は通す。メモは複数行で書かれる。
 *
 * ⚠️ `no-control-regex` を切っている。**制御文字を書きたいのではなく、
 * 制御文字を見つけたい**からである。この規則は「うっかり混ざった制御文字」を
 * 咎めるためのもので、意図して探す側には当てはまらない。
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

export interface OrderNoteDraft {
  readonly orderId: string;
  readonly authorAccountId: string;
  readonly body: string;
}

export interface ValidatedOrderNote {
  readonly orderId: string;
  readonly authorAccountId: string;
  readonly body: string;
}

/**
 * 対応メモを検証する。
 *
 * ⚠️ **平文のメールアドレスを弾く**（`UD-503`）。購入者のアドレスを
 * 保持しないと決めたのに、対応メモへ書き写せてしまうと、決めた意味が
 * 無くなる。しかもメモは注文と違って、どこにも「ここには個人情報が
 * ある」と書かれていない表へ溜まっていく。
 *
 * ⚠️ **HTML は弾かない。代わりに、表示側で決して HTML として描かない。**
 * ここは運営が書く自由文で、`<` を含む文が普通に出てくる
 * （「価格 < 送料 の件」など）。弾くと書けない文が生まれる。
 * 安全は「描き方」で担保する。
 */
export function validateOrderNote(draft: OrderNoteDraft): Result<ValidatedOrderNote, DomainError> {
  const body = draft.body.trim();
  if (body.length === 0) {
    return err(domainError('ORDER_NOTE_INVALID', 'empty'));
  }
  if (body.length > ORDER_NOTE_MAX_LENGTH) {
    return err(domainError('ORDER_NOTE_INVALID', 'too long'));
  }
  if (CONTROL_CHARS.test(body)) {
    return err(domainError('ORDER_NOTE_INVALID', 'control characters'));
  }
  if (EMAIL_LIKE.test(body)) {
    return err(domainError('ORDER_NOTE_INVALID', 'plaintext email'));
  }
  return ok({ orderId: draft.orderId, authorAccountId: draft.authorAccountId, body });
}
