import type { LegalDocumentVersion } from './document';

/**
 * 法務文書の本文を、描画できる形へ組み直す。
 *
 * ⚠️ **HTML 文字列を作らない。** 返すのは構造だけで、タグは作らない。
 * 文字列で返すと、受け取った側が `dangerouslySetInnerHTML` へ渡す道が
 * 開く。法務文書は利用者が疑わずに読む場所なので、その道を作らない。
 *
 * 解釈する印は次の 3 つだけ。増やすときは、増やす理由を書くこと。
 *  - `## ` で始まる行 … 見出し
 *  - `- ` で始まる行 … 箇条書き
 *  - 空行 … 段落の区切り
 */

export type LegalBlock =
  | { readonly type: 'heading'; readonly text: string }
  | { readonly type: 'paragraph'; readonly text: string }
  | { readonly type: 'list'; readonly items: readonly string[] };

const HEADING_MARK = '## ';
const LIST_MARK = '- ';

export function renderLegalBody(bodyText: string): readonly LegalBlock[] {
  const blocks: LegalBlock[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];

  const flush = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ type: 'paragraph', text: paragraph.join('\n') });
      paragraph = [];
    }
    if (list.length > 0) {
      blocks.push({ type: 'list', items: list });
      list = [];
    }
  };

  for (const rawLine of bodyText.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.trim() === '') {
      flush();
      continue;
    }
    if (line.startsWith(HEADING_MARK)) {
      flush();
      blocks.push({ type: 'heading', text: line.slice(HEADING_MARK.length).trim() });
      continue;
    }
    if (line.startsWith(LIST_MARK)) {
      if (paragraph.length > 0) {
        blocks.push({ type: 'paragraph', text: paragraph.join('\n') });
        paragraph = [];
      }
      list.push(line.slice(LIST_MARK.length).trim());
      continue;
    }
    if (list.length > 0) {
      blocks.push({ type: 'list', items: list });
      list = [];
    }
    paragraph.push(line);
  }
  flush();

  return blocks;
}

/**
 * 版の見出しに出す文言のもとになる値。
 *
 * ⚠️ **文言そのものは表示層で作る。** ここで日本語の文を組むと、
 * 画面ごとに違う言い回しになったときに直す先が散らばる。
 */
export interface LegalVersionLabel {
  readonly version: number;
  readonly effectiveFrom: Date | null;
}

export function versionLabel(version: LegalDocumentVersion): LegalVersionLabel {
  return { version: version.version, effectiveFrom: version.effectiveFrom };
}
