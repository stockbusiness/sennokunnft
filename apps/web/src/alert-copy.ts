import type { OperationsAlertSettingsView } from '@sengoku/contracts';

/**
 * 運営への知らせの設定の文言（`UD-1102` の一部）。
 *
 * ⚠️ **「お客さまのアドレスを入れる欄ではない」とはっきり書く。** 書かないと、
 * 問い合わせ対応のつもりで入れられ、異常の知らせがそのまま外へ出る。
 *
 * ⚠️ **「鳴りっぱなしにしない」ことを伝える。** 伝えないと、届かないのを
 * 壊れていると誤解される。
 */
export const ALERT_COPY = {
  title: '異常のお知らせ',
  description:
    '手当てが要ることが起きたときに、こちらからお知らせします。設定しないかぎり、運営の状況の画面を開くまで気づけません。',

  /** ⚠️ **いちばん大事な注意。** 宛先の欄のすぐ上に置く。 */
  recipientsWarning: 'お客さまのメールアドレスを入れないでください',
  recipientsWarningHint:
    'ここは運営の業務用アドレスを入れる欄です。お客さまのアドレスを入れると、異常のお知らせがそのままお客さまへ届きます。',

  enabledLabel: 'お知らせを送る',
  enabledHint: '切っているあいだは、何が起きてもお知らせは届きません。',

  minSeverityLabel: 'どこからお知らせするか',
  minSeverityCritical: '至急のものだけ',
  minSeverityWarning: '要確認のものから',
  minSeverityHint:
    '「要確認」から送ると、その日のうちに見ればよいものまで届きます。まずは「至急のものだけ」をおすすめします。',

  repeatLabel: '同じ状態が続くとき、次に送るまで',
  repeatUnit: '分',
  /*
    ⚠️ **短くしたくなる気持ちを、先回りして止める。** 短くすると、直すのに
       半日かかる異常で何十通も届く。届いた数だけ、次の知らせが読まれなくなる。
  */
  repeatHint:
    '短くすると、直すのに時間のかかる異常で何十通も届きます。届いた数だけ、次のお知らせが読まれなくなります。4 時間ほどをおすすめします。',

  recipientsLabel: '送り先（メール・改行で区切って 5 件まで）',
  recipientsPlaceholder: 'ops@example.com',

  webhookLabel: 'ほかの受け口（任意・Slack など）',
  webhookPlaceholder: 'https://hooks.slack.com/services/...',
  /*
    ⚠️ **URL 自体が合言葉であることを伝える。** 伝えないと、画面の共有や
       スクリーンショットで外へ出る。
  */
  webhookHint:
    'この URL 自体が合言葉です。包んでお預かりするので、登録後は画面に出ません（ホスト名までを表示します）。変更するときは、もう一度貼り付けてください。',
  webhookRegistered: (host: string): string => `登録済み（${host}）`,
  webhookMissing: '未登録',
  webhookClearHint: '空のまま保存すると、いまの登録が残ります。外すには「外す」を選んでください。',
  webhookClearLabel: 'いまの受け口を外す',

  submit: 'この内容で保存する',
  saving: '保存しています…',
  saved: '保存しました。',

  lastNotifiedLabel: '最後にお知らせした日時',
  lastNotifiedNever: 'まだ一度もお知らせしていません',

  /*
    ⚠️ **鳴りっぱなしにしない仕組みであることを、画面で伝える。** 伝えないと、
       届かないのを「壊れている」と誤解される。
  */
  suppressionNotice: '同じ状態が続くあいだ、お知らせは繰り返しません',
  suppressionHint:
    '中身が変わったときは、間隔を待たずにお知らせします。手当てが要ることが無くなったときも、そのことをお知らせします。',

  undeliverable: 'この配備では、お知らせを送れません',
  undeliverableHint:
    'メールの送信経路も、ほかの受け口も設定されていません。設定が要る旨を運用担当へお伝えください。',

  webhookUnstorable: 'この配備では、ほかの受け口をお預かりできません',
  webhookUnstorableHint: '暗号鍵が設定されていません。メールの送り先だけをご登録ください。',

  /*
    ⚠️ **時計が動いていなければ、この設定は効かない。** 設定しただけで
       安心されるのがいちばん困る。
  */
  needsClockNotice: 'お知らせは、時計仕掛けが回ったときに送られます',
  needsClockHint:
    '定時実行が設定されていないと、ここを設定してもお知らせは届きません。運営の状況の画面で「最終成功」をご確認ください。',

  ownerOnly: '設定を変えられるのはオーナーだけです',
  ownerOnlyHint:
    '送り先を差し替えられるということは、異常に気づく相手を選べるということです。決済の鍵と同じ扱いにしています。',
} as const;

/** 送り先が 1 つも無いか。⚠️ 有効なのに宛先が無い状態を画面が指摘する。 */
export function alertHasNoDestination(view: OperationsAlertSettingsView): boolean {
  return view.emailRecipients.length === 0 && view.webhookHost === null;
}

export function alertMinSeverityLabel(value: 'warning' | 'critical'): string {
  return value === 'critical' ? ALERT_COPY.minSeverityCritical : ALERT_COPY.minSeverityWarning;
}
