import { BadRequestException } from '@nestjs/common';

/**
 * 説明文の受け入れ判定。
 *
 * ⚠️ **HTML を保存しない。**
 * 「保存してから表示時にエスケープする」方式は、どこか 1 箇所で
 * エスケープを忘れた瞬間に保存型 XSS になる。
 * そもそも入れさせなければ、表示側の実装に関係なく安全になる。
 *
 * サニタイズ（危険なタグだけ除去）ではなく**拒否**にしているのは、
 * 「除去したつもりで残る」形を長期に渡って正しく維持するのが難しいため。
 * 装飾が必要になったら、HTML ではなく限定的な記法を別途設計する。
 */

/** タグらしき形、および HTML エンティティ・スクリプト URL を検出する。 */
const MARKUP_PATTERNS: readonly { readonly name: string; readonly re: RegExp }[] = [
  { name: 'tag', re: /<[a-zA-Z/!?]/ },
  { name: 'entity', re: /&(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/ },
  { name: 'script-url', re: /(?:javascript|data|vbscript)\s*:/i },
];

/**
 * 制御文字。改行・復帰・タブは本文として許し、それ以外は受け付けない。
 * 表示やログを壊すうえ、検査をすり抜けるための細工にも使われるため。
 */
// 制御文字を検出することがこの正規表現の目的なので、no-control-regex は意図的に外す。
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export interface PlainTextOptions {
  readonly field: string;
  readonly maxLength: number;
}

/**
 * 平文であることを確かめて返す。
 *
 * ⚠️ エラーに**入力値そのものを含めない**。
 * 反射させると、そのエラー画面自体が攻撃の足場になりうる。
 */
export function assertPlainText(value: string, options: PlainTextOptions): string {
  const reject = (reason: string): never => {
    throw new BadRequestException({
      error: {
        code: 'VALIDATION_ERROR',
        message: '入力内容が正しくありません。',
        details: [{ field: options.field, issue: reason }],
      },
    });
  };

  if (value.length > options.maxLength) {
    return reject('too_long');
  }
  if (CONTROL_CHARS.test(value)) {
    return reject('control_characters_not_allowed');
  }
  for (const pattern of MARKUP_PATTERNS) {
    if (pattern.re.test(value)) {
      return reject('markup_not_allowed');
    }
  }
  return value;
}
