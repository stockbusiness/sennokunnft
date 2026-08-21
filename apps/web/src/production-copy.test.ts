import { describe, expect, it } from 'vitest';
import {
  attestationKindLabel,
  attestationResultLabel,
  checkLabel,
  checkTone,
  enforcementNote,
  readinessMessage,
  unsatisfied,
} from './production-copy';

/** 本番販売ガードの言葉（P0-7）。 */

function check(key: string, satisfied: boolean) {
  return { key, label: key, satisfied, detail: '', remedy: '' } as never;
}

describe('条件の見せ方', () => {
  it('満たしていないものだけが赤', () => {
    expect(checkTone(false)).toBe('danger');
    expect(checkTone(true)).not.toBe('danger');
  });

  it('色だけで区別しない（言葉も出す）', () => {
    expect(checkLabel(true)).toBe('そろっています');
    expect(checkLabel(false)).toBe('まだです');
  });

  it('残っているものだけを取り出せる', () => {
    const rows = [check('a', true), check('b', false), check('c', false)];
    expect(unsatisfied(rows).map((row) => row.key)).toEqual(['b', 'c']);
  });
});

describe('先頭の一言', () => {
  it('そろっていれば、始められると伝える', () => {
    expect(readinessMessage(true, true)).toContain('始められます');
  });

  /*
    ⚠️ **「あと少し」と言わない。** 9 つ満たしていても売れない。
       件数で安心させると、残る 1 つが些細に見える。
  */
  it('そろっていなければ、始められないと言い切る', () => {
    const message = readinessMessage(false, true);
    expect(message).toContain('始められません');
    expect(message).not.toContain('あと');
  });

  /*
    ⚠️ **止まらない環境では、そのことをはっきり出す。** 「そろっている」
       ように見えて実は止めていない、がいちばん危ない。
  */
  it('止めない環境では、止めないことを伝える', () => {
    expect(readinessMessage(false, false)).toContain('本番では');
    expect(enforcementNote(false, 'staging')).toContain('staging');
    expect(enforcementNote(true, 'production')).toContain('作られません');
  });
});

describe('証跡の言い換え', () => {
  it('種別を運営の言葉にする', () => {
    expect(attestationKindLabel('e2e_sale_test')).toBe('通し試験');
    expect(attestationKindLabel('owner_approval')).toBe('責任者の承認');
  });

  it('知らない種別はそのまま出す（消えるより気づける）', () => {
    expect(attestationKindLabel('something_new')).toBe('something_new');
  });

  it('結果を短く出す', () => {
    expect(attestationResultLabel(true)).toBe('成立');
    expect(attestationResultLabel(false)).toBe('不成立');
  });
});
