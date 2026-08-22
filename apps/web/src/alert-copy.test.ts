import { describe, expect, it } from 'vitest';
import { ALERT_COPY, alertHasNoDestination, alertMinSeverityLabel } from './alert-copy';

/**
 * 異常のお知らせの文言（`UD-1102` の一部）。
 *
 * ⚠️ **この組が見張るのは、設定しただけで安心させる言い回しである。**
 * 時計が回っていなければ届かないこと、お客さまのアドレスを入れる欄では
 * ないこと、そして**鳴りっぱなしにしない仕組みであること**。
 */
describe('言い回し', () => {
  /*
    ⚠️ **お客さまのアドレスを入れる欄ではない**と、はっきり書く。書かないと、
       問い合わせ対応のつもりで入れられ、異常のお知らせが外へ出る。
  */
  it('お客さまのアドレスを入れないよう伝える', () => {
    expect(ALERT_COPY.recipientsWarning).toContain('お客さまのメールアドレスを入れないで');
    expect(ALERT_COPY.recipientsWarningHint).toContain('業務用アドレス');
  });

  /*
    ⚠️ **設定しただけで安心されないようにする。** 時計が回っていなければ
       届かない。
  */
  it('時計が回っていなければ届かないと伝える', () => {
    expect(ALERT_COPY.needsClockNotice).toContain('時計仕掛けが回ったとき');
    expect(ALERT_COPY.needsClockHint).toContain('定時実行が設定されていないと');
  });

  /*
    ⚠️ **鳴りっぱなしにしない仕組みであることを伝える。** 伝えないと、
       届かないのを「壊れている」と誤解される。
  */
  it('繰り返さないこと、直ったら知らせることを伝える', () => {
    expect(ALERT_COPY.suppressionNotice).toContain('繰り返しません');
    expect(ALERT_COPY.suppressionHint).toContain('間隔を待たずに');
    expect(ALERT_COPY.suppressionHint).toContain('無くなったときも');
  });

  /*
    ⚠️ **間隔を短くしたくなる気持ちを、先回りして止める。** 短くすると
       何十通も届き、次のお知らせが読まれなくなる。
  */
  it('間隔を短くしない理由を書く', () => {
    expect(ALERT_COPY.repeatHint).toContain('何十通も');
    expect(ALERT_COPY.repeatHint).toContain('読まれなくなります');
  });

  /*
    ⚠️ **受け口の URL 自体が合言葉であることを伝える。** 伝えないと、
       画面の共有やスクリーンショットで外へ出る。
  */
  it('受け口の URL が合言葉であると伝える', () => {
    expect(ALERT_COPY.webhookHint).toContain('URL 自体が合言葉');
    expect(ALERT_COPY.webhookHint).toContain('画面に出ません');
  });

  /*
    ⚠️ **オーナー限定にした理由を書く。** 「なぜ押せないのか」が分からないと、
       権限を広げてほしいという要望になる。
  */
  it('オーナー限定の理由を書く', () => {
    expect(ALERT_COPY.ownerOnlyHint).toContain('気づく相手を選べる');
  });
});

describe('送り先の有無', () => {
  const base = {
    enabled: true,
    minSeverity: 'critical' as const,
    repeatAfterMinutes: 240,
    emailRecipients: [],
    webhookHost: null,
    lastNotifiedAt: null,
    lastSeverity: null,
    deliverable: true,
    webhookStorable: true,
  };

  /** ⚠️ 有効なのに宛先が無い状態を、画面が指摘できるようにする。 */
  it('宛先が 1 つも無いことを見分けられる', () => {
    expect(alertHasNoDestination(base)).toBe(true);
    expect(alertHasNoDestination({ ...base, emailRecipients: ['ops@example.com'] })).toBe(false);
    expect(alertHasNoDestination({ ...base, webhookHost: 'hooks.example.com' })).toBe(false);
  });

  it('しきい値の呼び名を出す', () => {
    expect(alertMinSeverityLabel('critical')).toBe('至急のものだけ');
    expect(alertMinSeverityLabel('warning')).toBe('要確認のものから');
  });
});
