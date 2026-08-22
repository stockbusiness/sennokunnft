import { describe, expect, it } from 'vitest';
import {
  ALERT_MIN_SEVERITIES,
  alertFingerprint,
  buildAlertMessage,
  decideAlert,
  isValidAlertWebhookUrl,
  meetsThreshold,
  validateAlertRecipients,
  type AlertSettings,
  type AlertState,
} from '../../src/operations/alert';
import type { OperationsIndicator } from '../../src/operations/dashboard';

/**
 * 運営への知らせ（`UD-1102` の一部）。
 *
 * ⚠️ **この組の主題は 4 つ。**
 *  1. 鳴りっぱなしにしないこと（**見なくなった知らせは、無いより悪い**）
 *  2. 中身が変わったら間隔を待たずに知らせること
 *  3. **直ったことを知らせる**こと（鳴り止んだだけでは壊れたのか分からない）
 *  4. 知らせに個人情報を載せないこと（`UD-503`）
 */
const NOW = new Date('2026-08-22T00:00:00.000Z');

function settings(overrides: Partial<AlertSettings> = {}): AlertSettings {
  return {
    enabled: true,
    minSeverity: 'warning',
    repeatAfterMinutes: 240,
    emailRecipients: ['ops@example.com'],
    hasWebhook: false,
    ...overrides,
  };
}

function state(overrides: Partial<AlertState> = {}): AlertState {
  return { lastNotifiedAt: null, lastSeverity: null, lastFingerprint: null, ...overrides };
}

function indicator(overrides: Partial<OperationsIndicator> = {}): OperationsIndicator {
  return {
    key: 'issuance_failed',
    label: '受取権の発行を打ち切り',
    count: 2,
    severity: 'critical',
    action: '注文を開いて発行し直してください',
    ...overrides,
  };
}

describe('指紋', () => {
  /*
    ⚠️ **件数を含めない。** 含めると、待ちが 1 件増えるたびに「変わった」と
       みなされ、鳴りっぱなしになる。
  */
  it('件数が変わっても指紋は変わらない', () => {
    const a = alertFingerprint([indicator({ count: 2 })]);
    const b = alertFingerprint([indicator({ count: 40 })]);
    expect(a).toBe(b);
    // ⚠️ 空振りでないことを確かめる（空文字同士を比べていない）。
    expect(a).not.toBe('');
  });

  it('色が変われば指紋も変わる', () => {
    expect(alertFingerprint([indicator({ severity: 'critical' })])).not.toBe(
      alertFingerprint([indicator({ severity: 'warning' })]),
    );
  });

  /** ⚠️ 並びに依らない。画面の順序を替えただけで知らせが飛ばないように。 */
  it('並びを入れ替えても同じ指紋になる', () => {
    const one = indicator({ key: 'a' });
    const two = indicator({ key: 'b', severity: 'warning' });
    expect(alertFingerprint([one, two])).toBe(alertFingerprint([two, one]));
  });

  it('平常の項目は指紋に入らない', () => {
    expect(alertFingerprint([indicator({ severity: 'normal' })])).toBe('');
  });

  /*
    ⚠️ **止めている項目も指紋に入らない（2026-08-22）。** 入れると、
       フラグを下ろしているだけの配備で「異常あり」の指紋ができ、
       **知らせが止まらなくなる**。
  */
  it('止めている項目は指紋に入らない', () => {
    expect(alertFingerprint([indicator({ severity: 'paused' })])).toBe('');
  });
});

describe('止めている項目としきい値', () => {
  /*
    ⚠️ **どのしきい値でも知らせない。** 止めていることを毎回知らせても、
       受け取った人にできることは無い。
  */
  it('いちばん低いしきい値でも届かない', () => {
    for (const min of ALERT_MIN_SEVERITIES) {
      expect(meetsThreshold('paused', min)).toBe(false);
    }
  });
});

describe('知らせるかどうか', () => {
  it('切ってあれば送らない', () => {
    expect(
      decideAlert({
        settings: settings({ enabled: false }),
        severity: 'critical',
        fingerprint: 'x',
        state: state(),
        now: NOW,
      }),
    ).toEqual({ kind: 'skip', reason: 'disabled' });
  });

  /*
    ⚠️ **宛先が無ければ、判定より先に断る。** 「知らせた」という記録だけが
       残って、誰も受け取っていない状態を作らない。
  */
  it('宛先が 1 つも無ければ送らない', () => {
    expect(
      decideAlert({
        settings: settings({ emailRecipients: [], hasWebhook: false }),
        severity: 'critical',
        fingerprint: 'x',
        state: state(),
        now: NOW,
      }),
    ).toEqual({ kind: 'skip', reason: 'no_destination' });
  });

  it('しきい値に届かなければ送らない', () => {
    expect(
      decideAlert({
        settings: settings({ minSeverity: 'critical' }),
        severity: 'warning',
        fingerprint: 'x',
        state: state(),
        now: NOW,
      }),
    ).toEqual({ kind: 'skip', reason: 'below_threshold' });
  });

  it('はじめての異常は送る', () => {
    expect(
      decideAlert({
        settings: settings(),
        severity: 'critical',
        fingerprint: 'x',
        state: state(),
        now: NOW,
      }),
    ).toEqual({ kind: 'notify', reason: 'new' });
  });

  /*
    ⚠️ **鳴りっぱなしにしない。** 同じ状態が続いているあいだ毎回送ると、
       受け取る側は数日で見なくなる。
  */
  it('同じ状態が続いているあいだは、間隔を空けるまで送らない', () => {
    const previous = state({
      lastNotifiedAt: new Date(NOW.getTime() - 60 * 60_000),
      lastSeverity: 'critical',
      lastFingerprint: 'x',
    });
    expect(
      decideAlert({
        settings: settings(),
        severity: 'critical',
        fingerprint: 'x',
        state: previous,
        now: NOW,
      }),
    ).toEqual({ kind: 'skip', reason: 'too_soon' });
  });

  it('間隔を過ぎたら、もう一度送る', () => {
    const previous = state({
      lastNotifiedAt: new Date(NOW.getTime() - 241 * 60_000),
      lastSeverity: 'critical',
      lastFingerprint: 'x',
    });
    expect(
      decideAlert({
        settings: settings(),
        severity: 'critical',
        fingerprint: 'x',
        state: previous,
        now: NOW,
      }),
    ).toEqual({ kind: 'notify', reason: 'repeat' });
  });

  /*
    ⚠️ **中身が変わったら、間隔を待たずに知らせる。** 黄色が赤に変わった
       ことを 4 時間伏せてよい理由が無い。
  */
  it('中身が変われば、間隔を待たずに送る', () => {
    const previous = state({
      lastNotifiedAt: new Date(NOW.getTime() - 60_000),
      lastSeverity: 'warning',
      lastFingerprint: 'x',
    });
    expect(
      decideAlert({
        settings: settings(),
        severity: 'critical',
        fingerprint: 'y',
        state: previous,
        now: NOW,
      }),
    ).toEqual({ kind: 'notify', reason: 'changed' });
  });

  /*
    ⚠️ **直ったことを知らせる。** 鳴り止んだだけでは、直ったのか、
       知らせが壊れたのかが分からない。
  */
  it('平常へ戻ったら知らせる', () => {
    const previous = state({
      lastNotifiedAt: new Date(NOW.getTime() - 60_000),
      lastSeverity: 'critical',
      lastFingerprint: 'x',
    });
    expect(
      decideAlert({
        settings: settings(),
        severity: 'normal',
        fingerprint: '',
        state: previous,
        now: NOW,
      }),
    ).toEqual({ kind: 'notify', reason: 'recovered' });
  });

  it('もともと鳴っていなければ、平常でも送らない', () => {
    expect(
      decideAlert({
        settings: settings(),
        severity: 'normal',
        fingerprint: '',
        state: state(),
        now: NOW,
      }),
    ).toEqual({ kind: 'skip', reason: 'below_threshold' });
  });

  /*
    ⚠️ **復旧はしきい値に関わらず知らせる。** 鳴らした以上、鳴り止んだ
       理由を伝える責任がある。
  */
  it('しきい値が赤でも、復旧は知らせる', () => {
    const previous = state({
      lastNotifiedAt: new Date(NOW.getTime() - 60_000),
      lastSeverity: 'critical',
      lastFingerprint: 'x',
    });
    expect(
      decideAlert({
        settings: settings({ minSeverity: 'critical' }),
        severity: 'normal',
        fingerprint: '',
        state: previous,
        now: NOW,
      }),
    ).toEqual({ kind: 'notify', reason: 'recovered' });
  });
});

describe('文面', () => {
  /*
    ⚠️ **知らせに個人情報を載せない**（`UD-503`）。知らせは受信箱と外部の
       受け口へ流れていく。流れた先まで、こちらの管理は及ばない。
  */
  it('項目名と件数までしか載せない', () => {
    const message = buildAlertMessage({
      severity: 'critical',
      reason: 'new',
      indicators: [indicator()],
      dashboardUrl: 'https://example.com/admin',
    });
    expect(message.body).toContain('受取権の発行を打ち切り');
    expect(message.body).toContain('2 件');
    // ⚠️ 赤には次の一手を必ず添える。
    expect(message.body).toContain('発行し直してください');
    expect(message.body).toContain('お客さまの情報は含まれていません');
    // ⚠️ 外部の受け口へ渡す形にも、項目名と件数しか入らない。
    expect(message.payload.items).toEqual([{ label: '受取権の発行を打ち切り', count: 2 }]);
  });

  it('平常の項目は文面に出ない', () => {
    const message = buildAlertMessage({
      severity: 'critical',
      reason: 'new',
      indicators: [
        indicator(),
        indicator({ key: 'today_orders', label: '本日のご注文', severity: 'normal' }),
      ],
      dashboardUrl: 'https://example.com/admin',
    });
    expect(message.body).not.toContain('本日のご注文');
    expect(message.subject).toContain('1 件');
  });

  it('復旧の知らせに、異常の中身を並べない', () => {
    const message = buildAlertMessage({
      severity: 'normal',
      reason: 'recovered',
      indicators: [indicator()],
      dashboardUrl: 'https://example.com/admin',
    });
    expect(message.body).not.toContain('受取権の発行を打ち切り');
    expect(message.payload.items).toEqual([]);
  });
});

describe('宛先と受け口', () => {
  it('形の違う宛先は断る', () => {
    expect(validateAlertRecipients(['ops@example.com']).ok).toBe(true);
    expect(validateAlertRecipients(['ops']).ok).toBe(false);
  });

  /** ⚠️ 同じ宛先を重ねない。重ねると同じ人に何通も届く。 */
  it('同じ宛先を重ねない', () => {
    const result = validateAlertRecipients(['ops@example.com', ' ops@example.com ', '']);
    expect(result.ok).toBe(true);
    expect(result.ok ? result.value : []).toEqual(['ops@example.com']);
  });

  it('宛先が多すぎれば断る', () => {
    expect(
      validateAlertRecipients(['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', 'e@x.com', 'f@x.com'])
        .ok,
    ).toBe(false);
  });

  /** ⚠️ 平文で送ると、経路の途中で異常の中身が読まれる。 */
  it('受け口は https だけ', () => {
    expect(isValidAlertWebhookUrl('https://hooks.example.com/abc')).toBe(true);
    expect(isValidAlertWebhookUrl('http://hooks.example.com/abc')).toBe(false);
    expect(isValidAlertWebhookUrl('つながらない')).toBe(false);
  });
});
