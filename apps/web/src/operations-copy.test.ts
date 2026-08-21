import { describe, expect, it } from 'vitest';
import {
  formatJst,
  indicatorValue,
  notificationEventLabel,
  notificationStatusLabel,
  notificationStatusTone,
  overallMessage,
  severityLabel,
  severityTone,
  entitlementStatusLabel,
  walletDeliveryLabel,
} from './operations-copy';

/** 運営画面の言葉（実運営 指示書 P0-6）。 */

describe('深刻度の見せ方', () => {
  /*
    ⚠️ **赤は `critical` だけ。** 黄色まで赤にすると、運営は毎朝赤を見て、
       そのうち見なくなる。赤が意味を持つのは、赤でないときがある場合だけ。
  */
  it('赤くなるのは critical だけ', () => {
    expect(severityTone('critical')).toBe('danger');
    expect(severityTone('warning')).not.toBe('danger');
    expect(severityTone('normal')).not.toBe('danger');
  });

  /*
    ⚠️ **色だけで区別しない。** 見分けがつかない方にも順番が伝わるよう、
       印には必ず言葉を入れる。
  */
  it('印には言葉が入る', () => {
    expect(severityLabel('critical')).toBe('要対応');
    expect(severityLabel('warning')).toBe('確認');
    expect(severityLabel('normal')).toBe('平常');
  });

  it('先頭の一言は、何をすればよいかから始まる', () => {
    expect(overallMessage('critical')).toContain('手当て');
    expect(overallMessage('normal')).toContain('ありません');
  });
});

describe('指標の値', () => {
  /*
    ⚠️ **売上を「件」と書かない。** 桁が大きいので気づきにくく、
       気づいたときには朝礼で読み上げられている。
  */
  it('売上は円、それ以外は件', () => {
    expect(indicatorValue('today_paid_amount', 12000)).toBe('12,000 円');
    expect(indicatorValue('today_order_count', 3)).toBe('3 件');
  });

  it('数える対象が無いものは「—」', () => {
    expect(indicatorValue('webhook_last_received', null)).toBe('—');
  });
});

describe('状態の言い換え', () => {
  /*
    ⚠️ **Web3 の言葉を出さない。** 買った方も運営も、内部の語彙を
       知っている必要はない。
  */
  it('受取権とお届けの状態を日本語にする', () => {
    expect(entitlementStatusLabel('issued')).toBe('お受け取り前');
    expect(entitlementStatusLabel('claimed')).toBe('お受け取り済み');
    expect(walletDeliveryLabel('delivered')).toBe('お届け済み');
  });

  it('知らない値は握り潰さずそのまま出す（消えるより気づける）', () => {
    expect(entitlementStatusLabel('unknown_state')).toBe('unknown_state');
    expect(notificationEventLabel('some.new.event')).toBe('some.new.event');
  });

  it('知らせの種別を運営の言葉にする', () => {
    expect(notificationEventLabel('wallet.delivery_stalled')).toBe('お届けの遅れのお詫び');
  });

  /*
    ⚠️ **打ち切りだけを赤にする。** 一度失敗しただけのものは、
       次の巡回で送られる見込みがある。
  */
  it('送信を打ち切ったものだけが赤', () => {
    expect(notificationStatusTone('DEAD')).toBe('danger');
    expect(notificationStatusTone('FAILED')).toBe('warning');
    expect(notificationStatusTone('SENT')).toBe('success');
    expect(notificationStatusLabel('SENT')).toBe('送信済み');
  });
});

describe('日時', () => {
  /*
    ⚠️ **JST で出す。** UTC のまま出すと、9 時間ずれた時刻を
       そのまま信じられる。
  */
  it('UTC を JST へ直して出す', () => {
    expect(formatJst('2026-08-21T00:30:00.000Z')).toBe('2026/08/21 09:30');
  });

  it('無いもの・読めないものは「—」（1970年と表示しない）', () => {
    expect(formatJst(null)).toBe('—');
    expect(formatJst('これは日時ではない')).toBe('—');
  });
});
