import { describe, expect, it } from 'vitest';
import {
  REDACTED_MARK,
  decodeListCursor,
  encodeListCursor,
  redactAuditSummary,
} from '../src/index';

/**
 * 監査ログの要約を画面へ出す前の伏せ字。
 *
 * ここで守りたいのは「連絡先が、見せる相手を絞らずに表示されない」こと。
 * 実際に `staff.invite` の要約には招待先のメールアドレスが入っている。
 */
describe('redactAuditSummary', () => {
  it('連絡先を出してよい相手には、そのまま渡す', () => {
    const redacted = redactAuditSummary(
      { email: 'ops@example.com', role: 'operator' },
      { includeContact: true },
    );
    expect(redacted).toEqual({ email: 'ops@example.com', role: 'operator' });
  });

  it('連絡先を出せない相手には伏せる', () => {
    const redacted = redactAuditSummary(
      { email: 'ops@example.com', role: 'operator' },
      { includeContact: false },
    );
    expect(redacted).toEqual({ email: REDACTED_MARK, role: 'operator' });
  });

  /*
    ⚠️ **鍵の名前で判定していないことを確かめる。**
       許可リスト方式にすると、新しい操作を足した人が書き足し忘れたときに
       黙って表示される。値の形で判定していれば、鍵の名前が何であっても効く。
  */
  it('鍵の名前が違っても、連絡先らしい値なら伏せる', () => {
    const redacted = redactAuditSummary(
      { contact: 'someone@example.co.jp', note: 'ふつうの文字列' },
      { includeContact: false },
    );
    expect(redacted).toEqual({ contact: REDACTED_MARK, note: 'ふつうの文字列' });
  });

  it('入れ子と配列の中まで届く', () => {
    const redacted = redactAuditSummary(
      { invited: [{ email: 'a@example.com' }, { email: 'b@example.com' }] },
      { includeContact: false },
    );
    expect(redacted).toEqual({
      invited: [{ email: REDACTED_MARK }, { email: REDACTED_MARK }],
    });
  });

  it('連絡先でない値は、伏せずに残す', () => {
    const redacted = redactAuditSummary(
      { changed: ['title', 'description'], isOwner: true, count: 3, missing: null },
      { includeContact: false },
    );
    expect(redacted).toEqual({
      changed: ['title', 'description'],
      isOwner: true,
      count: 3,
      missing: null,
    });
  });

  it('長すぎる文字列は切り詰める', () => {
    const redacted = redactAuditSummary({ note: 'あ'.repeat(500) }, { includeContact: true });
    // 200 文字 + 省略記号。
    expect(String(redacted.note)).toHaveLength(201);
  });
});

describe('配送一覧のカーソル', () => {
  it('書いて読み戻すと同じ位置になる', () => {
    const cursor = { at: new Date('2026-08-18T04:05:06.789Z'), id: 'row-1' };
    const decoded = decodeListCursor(encodeListCursor(cursor));
    expect(decoded?.id).toBe('row-1');
    expect(decoded?.at.toISOString()).toBe('2026-08-18T04:05:06.789Z');
  });

  /*
    読めない値で落とさない。カーソルは URL に載るので、
    利用者が手で書き換えた値がそのまま届く。
  */
  it('読めない値は null（先頭から読み直す）', () => {
    expect(decodeListCursor('')).toBeNull();
    expect(decodeListCursor('_row-1')).toBeNull();
    expect(decodeListCursor('2026-08-18T04:05:06.789Z_')).toBeNull();
    expect(decodeListCursor('こわれた値_row-1')).toBeNull();
  });

  it('行IDに区切り文字が含まれても壊れない', () => {
    const cursor = { at: new Date('2026-08-18T00:00:00.000Z'), id: 'a_b_c' };
    expect(decodeListCursor(encodeListCursor(cursor))?.id).toBe('a_b_c');
  });
});
