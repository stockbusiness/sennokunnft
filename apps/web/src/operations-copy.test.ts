import { describe, expect, it } from 'vitest';
import { DISPUTE_REASONS, DISPUTE_STATUSES, DISPUTE_URGENCIES } from '@sengoku/contracts';
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
  disputeReasonLabel,
  disputeStatusLabel,
  disputeUrgencyLabel,
  disputeUrgencyTone,
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

/**
 * 争いの見出しが全件そろっているか（2026-08-22）。
 *
 * ⚠️ **一度やっている。** 時計仕掛けの見出し（`JOB_LABELS`）で 2 件だけ
 * 抜けていて、管理画面に英語の符号がそのまま出た。契約の語彙を回して
 * 確かめれば、語彙が増えたときにここで落ちる。
 */
const HAS_JAPANESE = /[ぁ-んァ-ヶ一-龠]/u;

describe('争いの見出し', () => {
  it('すべての状態に日本語の見出しがある', () => {
    for (const status of DISPUTE_STATUSES) {
      const label = disputeStatusLabel(status);
      expect(label, status).toMatch(HAS_JAPANESE);
      /*
        ⚠️ **「不明」で埋まっていないことも見る。** 既定へ落ちているだけの
           ものを「見出しがある」と数えると、この試験は何も守らない。
           （状態には `unknown` が無いので、全件で見てよい。）
      */
      expect(label, status).not.toBe('不明');
    }
  });

  it('すべての事由に日本語の見出しがある', () => {
    for (const reason of DISPUTE_REASONS) {
      const label = disputeReasonLabel(reason);
      expect(label, reason).toMatch(HAS_JAPANESE);
      if (reason !== 'unknown') {
        expect(label, reason).not.toBe('不明');
      }
    }
  });

  it('すべての急ぎ具合に日本語の見出しと色がある', () => {
    for (const urgency of DISPUTE_URGENCIES) {
      expect(disputeUrgencyLabel(urgency), urgency).toMatch(HAS_JAPANESE);
      expect(disputeUrgencyLabel(urgency), urgency).not.toBe('不明');
      expect(disputeUrgencyTone(urgency), urgency).not.toBe('');
    }
  });

  it('知らない値は英語のまま出さない', () => {
    /*
      ⚠️ **事業者が語彙を増やすことがある。** そのまま出すと、管理画面に
         英語の符号が並ぶ。既定へ倒して「不明」と書く。
    */
    expect(disputeStatusLabel('brand_new_status_from_provider')).toBe('不明');
    expect(disputeReasonLabel('brand_new_reason_from_provider')).toBe('不明');
  });

  it('期限が近いものと過ぎたものだけを赤にする', () => {
    /*
      ⚠️ **すべてを赤にすると、急ぐべきものが埋もれる。** 対応中は黄、
         決着したものは色を付けない。
    */
    expect(disputeUrgencyTone('overdue')).toBe('danger');
    expect(disputeUrgencyTone('due_soon')).toBe('danger');
    expect(disputeUrgencyTone('open')).toBe('warning');
    expect(disputeUrgencyTone('closed')).toBe('neutral');
  });
});
