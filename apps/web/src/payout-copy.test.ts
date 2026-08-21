import { describe, expect, it } from 'vitest';
import { PAYOUT_COPY, payoutAccountTypeLabel } from './payout-copy';

/**
 * 精算の画面文言（`UD-119` ／ お振込先は決定 2026-08-21）。
 *
 * ⚠️ **この組が見張るのは、誤解を招く言い回しである。** 押しても振込は
 * 起きないこと、確かめられたのは形だけであること、そして
 * **解けなかったときに振り込ませないこと**。
 */
describe('お支払い済みの言い回し', () => {
  /*
    ⚠️ **「お支払い済みにする」は「振り込んだ」という宣言。** 押しても
       振込は起きない。ここが曖昧だと、押せば振り込まれると思われる。
  */
  it('押せば振り込まれると読めないようにする', () => {
    expect(PAYOUT_COPY.markPaidWarning).toContain('振込は行われません');
    expect(PAYOUT_COPY.markPaidHint).toContain('実際にお振込を済ませてから');
  });
});

describe('お振込先の言い回し', () => {
  /*
    ⚠️ **「確認済み」と書かない**（`UD-124` 決定 2026-08-21）。確かめられる
       のは形だけで、口座が実在するかは振込を試みたときに初めて分かる。
       「確認済み」と書くと、運営が確かめたことになってしまう。
  */
  it('お振込先を「確認済み」と書かない', () => {
    expect(PAYOUT_COPY.accountRegistered).toBe('ご登録いただいています');
    expect(PAYOUT_COPY.accountRegistered).not.toContain('確認');
  });

  /*
    ⚠️ **押す前に、記録が残ることを伝える。** 伝えずに残すと、
       「見られていると思わなかった」が生まれる。
  */
  it('表示すると記録が残ることを、押す前に伝える', () => {
    expect(PAYOUT_COPY.revealNotice).toContain('記録に残ります');
    expect(PAYOUT_COPY.revealNotice).toContain('どなたが');
  });

  /*
    ⚠️ **解けなかったときにいちばん大事なのは「振り込まないこと」。**
       「あとで直る不具合」に読めると、そのまま振り込もうとする人が出る。
  */
  it('読み取れなかったときは、振り込まないよう伝える', () => {
    expect(PAYOUT_COPY.revealUndecipherableHint).toContain('お振込にならないでください');
    // ⚠️ 「時間をおいて」と書かない。待っても直らない。
    expect(PAYOUT_COPY.revealUndecipherableHint).not.toContain('時間をおいて');
  });

  /*
    ⚠️ **運営が代わりに登録する口は無い。** 伺っても入れる場所がなく、
       受信箱に口座情報が残るだけになる。
  */
  it('未登録のときに、運営が口座を伺わないよう伝える', () => {
    expect(PAYOUT_COPY.accountMissingHint).toContain('伺わないでください');
    expect(PAYOUT_COPY.accountMissingHint).toContain('作家さまご自身');
  });

  /*
    ⚠️ **直前の差し替えは、乗っ取りでいちばん実入りのよい形。**
       気づける手掛かりを画面に置く。
  */
  it('お振込の直前に変わっていたら確かめるよう促す', () => {
    expect(PAYOUT_COPY.accountUpdatedAtHint).toContain('直前に変わっている');
    expect(PAYOUT_COPY.accountUpdatedAtHint).toContain('ご本人');
  });

  /** ⚠️ 通帳の表記に合わせる。合わせないと振込の依頼書と突き合わせられない。 */
  it('預金種別を通帳の表記で出す', () => {
    expect(payoutAccountTypeLabel('ordinary')).toBe('普通');
    expect(payoutAccountTypeLabel('checking')).toBe('当座');
  });
});
