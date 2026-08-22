import type { OperationsIndicator, OperationsSeverity } from './dashboard';

/**
 * 運営への知らせ（`UD-1102` の一部・実装 2026-08-22）。
 *
 * **記録はあるが、気づく仕組みが無かった。** 運営の状況（P0-6）は作ったが、
 * **誰かが見に行かない限り、時計が止まっていても分からない**。見に行かせる
 * のではなく、こちらから届ける。
 *
 * ⚠️ **鳴りっぱなしにしない。** 同じ状態が続いているあいだ毎回送ると、
 * 受け取る側は数日で見なくなる。**見なくなった知らせは、無いのと同じ**
 * どころか「知らせているつもり」になるぶん悪い。
 *
 * ⚠️ **直ったことも知らせる。** 鳴り止んだだけでは、直ったのか、
 * 知らせが壊れたのかが分からない。
 *
 * ⚠️ **知らせに個人情報を載せない**（`UD-503`）。載せてよいのは
 * **項目名と件数**まで。知らせは運営の受信箱と、外部の受け口（Slack 等）
 * へ流れていく——流れた先まで、こちらの管理は及ばない。
 *
 * ⚠️ **ここに時計も送信手段も持たない。** 現在時刻も送る口も呼び出し元が
 * 渡す。持たせると、抑制の境目を試験で再現できなくなる。
 */

/** どこから知らせるか。⚠️ `normal` は選べない（平常を知らせても意味が無い）。 */
export const ALERT_MIN_SEVERITIES = ['warning', 'critical'] as const;
export type AlertMinSeverity = (typeof ALERT_MIN_SEVERITIES)[number];

/**
 * 同じ状態が続くときに、次に知らせるまでの間隔。
 *
 * ⚠️ **既定を短くしない。** 短くすると、直すのに半日かかる異常で
 * 何十通も届く。届いた数だけ、次の知らせが読まれなくなる。
 */
export const DEFAULT_ALERT_REPEAT_AFTER_MINUTES = 240;
export const MIN_ALERT_REPEAT_AFTER_MINUTES = 15;
export const MAX_ALERT_REPEAT_AFTER_MINUTES = 60 * 24;

/** 宛先の数の上限。⚠️ 増やしすぎると、誰も自分ごとと思わなくなる。 */
export const MAX_ALERT_EMAIL_RECIPIENTS = 5;

/** 前回どう知らせたか。⚠️ **無い＝一度も知らせていない。** */
export interface AlertState {
  readonly lastNotifiedAt: Date | null;
  readonly lastSeverity: OperationsSeverity | null;
  /** 前回の指紋。⚠️ 件数を含まない（下の `alertFingerprint` を参照）。 */
  readonly lastFingerprint: string | null;
}

export interface AlertSettings {
  readonly enabled: boolean;
  readonly minSeverity: AlertMinSeverity;
  readonly repeatAfterMinutes: number;
  readonly emailRecipients: readonly string[];
  /** 外部の受け口があるか。⚠️ **URL そのものはここに載せない**（包んである）。 */
  readonly hasWebhook: boolean;
}

/**
 * いま知らせるべきか。
 *
 * ⚠️ **「送らない」にも理由を付けて返す。** 運営が「なぜ届かないのか」を
 * 画面から確かめられるようにする。理由が分からない沈黙は、**壊れているのと
 * 見分けが付かない**。
 */
export type AlertReason = 'new' | 'changed' | 'repeat' | 'recovered';
export type AlertSkipReason =
  'disabled' | 'below_threshold' | 'no_destination' | 'too_soon' | 'unchanged';

export type AlertDecision =
  | { readonly kind: 'notify'; readonly reason: AlertReason }
  | { readonly kind: 'skip'; readonly reason: AlertSkipReason };

/**
 * 異常の指紋。
 *
 * ⚠️ **件数を含めない。** 含めると、待ちが 1 件増えるたびに「変わった」と
 * みなされ、鳴りっぱなしになる。**変わったとみなすのは、どの項目が
 * どの色になったかが変わったとき**だけ。
 *
 * ⚠️ **並びに依らない値にする。** 指標の順序を入れ替えただけで別の異常に
 * 見えると、画面を触るたびに知らせが飛ぶ。
 */
export function alertFingerprint(indicators: readonly OperationsIndicator[]): string {
  return (
    indicators
      /*
      ⚠️ **`paused` を数に入れない（2026-08-22）。** 止めている処理は
         異常ではない。入れると、フラグを下ろしているだけの配備で
         「異常あり」の指紋ができ、**知らせが止まらなくなる**。
    */
      .filter((row) => row.severity !== 'normal' && row.severity !== 'paused')
      .map((row) => `${row.key}:${row.severity}`)
      .sort()
      .join('|')
  );
}

const SEVERITY_RANK: Readonly<Record<OperationsSeverity, number>> = {
  /*
    ⚠️ **`paused` は平常より下（2026-08-22）。** どのしきい値を選んでも
       知らせが飛ばないようにする。止めていることを毎回知らせても、
       受け取る側にできることは無い。
  */
  paused: -1,
  normal: 0,
  warning: 1,
  critical: 2,
};

export function meetsThreshold(
  severity: OperationsSeverity,
  minSeverity: AlertMinSeverity,
): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[minSeverity];
}

export function decideAlert(input: {
  readonly settings: AlertSettings;
  readonly severity: OperationsSeverity;
  readonly fingerprint: string;
  readonly state: AlertState;
  readonly now: Date;
}): AlertDecision {
  const { settings, severity, fingerprint, state, now } = input;

  if (!settings.enabled) {
    return { kind: 'skip', reason: 'disabled' };
  }
  /*
    ⚠️ **宛先が無ければ、判定より先に断る。** 「知らせた」という記録だけが
       残って、誰も受け取っていない状態を作らない。
  */
  if (settings.emailRecipients.length === 0 && !settings.hasWebhook) {
    return { kind: 'skip', reason: 'no_destination' };
  }

  /*
    ⚠️ **直ったことは、しきい値に関わらず知らせる。** 鳴らした以上、
       鳴り止んだ理由を伝える責任がある。伝えないと、受け取る側は
       「まだ続いているが知らせが壊れた」と区別できない。
  */
  const wasNotified = state.lastSeverity !== null && state.lastSeverity !== 'normal';
  if (severity === 'normal') {
    return wasNotified
      ? { kind: 'notify', reason: 'recovered' }
      : { kind: 'skip', reason: 'below_threshold' };
  }

  if (!meetsThreshold(severity, settings.minSeverity)) {
    return { kind: 'skip', reason: 'below_threshold' };
  }

  if (!wasNotified) {
    return { kind: 'notify', reason: 'new' };
  }

  /*
    ⚠️ **中身が変わったら、間隔を待たずに知らせる。** 黄色が赤に変わった
       ことを 4 時間伏せてよい理由が無い。
  */
  if (state.lastFingerprint !== fingerprint) {
    return { kind: 'notify', reason: 'changed' };
  }

  if (state.lastNotifiedAt === null) {
    return { kind: 'notify', reason: 'new' };
  }
  const elapsedMinutes = (now.getTime() - state.lastNotifiedAt.getTime()) / 60_000;
  return elapsedMinutes >= settings.repeatAfterMinutes
    ? { kind: 'notify', reason: 'repeat' }
    : { kind: 'skip', reason: 'too_soon' };
}

/** 知らせの中身。⚠️ **個人情報を含めない。** 項目名と件数まで。 */
export interface AlertMessage {
  readonly subject: string;
  readonly body: string;
  /** 外部の受け口へ渡す形。⚠️ ここにも個人情報を入れない。 */
  readonly payload: {
    readonly severity: OperationsSeverity;
    readonly reason: string;
    readonly items: readonly { readonly label: string; readonly count: number | null }[];
  };
}

const SEVERITY_LABELS: Readonly<Record<OperationsSeverity, string>> = {
  /*
    ⚠️ **知らせの見出しに `paused` は出ない**（しきい値に届かないため）。
       それでも書いておく——網羅を外すと、将来しきい値を触ったときに
       英字がそのまま件名へ出る。
  */
  paused: '止めています',
  normal: '平常',
  warning: '要確認',
  critical: '至急',
};

/**
 * 文面を組み立てる。
 *
 * ⚠️ **赤に必ず次の一手を添える**（画面と同じ考え方）。「異常です」だけを
 * 送っても、受け取った人は何をすればよいか分からない。
 *
 * ⚠️ **本文に注文番号もお名前も入れない**（`UD-503`）。知らせは受信箱と
 * 外部の受け口へ流れていく。流れた先まで、こちらの管理は及ばない。
 */
export function buildAlertMessage(input: {
  readonly severity: OperationsSeverity;
  readonly reason: AlertReason;
  readonly indicators: readonly OperationsIndicator[];
  readonly dashboardUrl: string;
}): AlertMessage {
  const { severity, reason, indicators, dashboardUrl } = input;
  const flagged = indicators.filter((row) => row.severity !== 'normal');

  if (reason === 'recovered') {
    return {
      subject: '【千ノ国・運営】手当てが要ることは無くなりました',
      body: [
        'さきほどお知らせした件は、いまは解消しています。',
        '',
        `状況の画面: ${dashboardUrl}`,
        '',
        '⚠️ このお知らせに、お客さまの情報は含まれていません。',
      ].join('\n'),
      payload: { severity, reason, items: [] },
    };
  }

  const lines = flagged.map(
    (row) =>
      `[${SEVERITY_LABELS[row.severity]}] ${row.label}` +
      (row.count === null ? '' : `（${String(row.count)} 件）`) +
      (row.action === null ? '' : `\n    → ${row.action}`),
  );

  return {
    subject: `【千ノ国・運営】${SEVERITY_LABELS[severity]}: 手当てが要ることが ${String(flagged.length)} 件あります`,
    body: [
      ...lines,
      '',
      `状況の画面: ${dashboardUrl}`,
      '',
      '⚠️ このお知らせに、お客さまの情報は含まれていません。',
    ].join('\n'),
    payload: {
      severity,
      reason,
      items: flagged.map((row) => ({ label: row.label, count: row.count })),
    },
  };
}

/**
 * 宛先として受け付けてよいか。
 *
 * ⚠️ **ここに入れるのは運営の業務用アドレスだけ。** お客さまのアドレスを
 * 入れると、異常の知らせがそのまま外へ出る。**画面でもそう伝える。**
 */
export function validateAlertRecipients(
  recipients: readonly string[],
): { readonly ok: true; readonly value: readonly string[] } | { readonly ok: false } {
  const cleaned = recipients.map((row) => row.trim()).filter((row) => row !== '');
  if (cleaned.length > MAX_ALERT_EMAIL_RECIPIENTS) {
    return { ok: false };
  }
  /*
    ⚠️ **形だけを見る。** 実在するかは送ってみるまで分からない。
       「確認済み」と読ませない（画面の文言も同じ考え方）。
  */
  if (cleaned.some((row) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(row))) {
    return { ok: false };
  }
  // ⚠️ 同じ宛先を重ねない。重ねると同じ人に何通も届く。
  return { ok: true, value: [...new Set(cleaned)] };
}

/**
 * 外部の受け口の URL として受け付けてよいか。
 *
 * ⚠️ **`https` だけ。** 平文で送ると、経路の途中で異常の中身が読まれる。
 *
 * ⚠️ **URL 自体が合言葉である**（Slack の受け口などがそう）。読み戻しでは
 * 返さず、包んで保管する。
 */
export function isValidAlertWebhookUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}
