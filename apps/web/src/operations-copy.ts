import type { OperationsSeverity } from '@sengoku/contracts';
import type { StatusToneName } from '@sengoku/ui';

/**
 * 運営ダッシュボードの言葉（P0-6）。
 *
 * ⚠️ **赤は「いま手を動かす」ときだけ。** 数が多いだけで赤くすると、
 * 運営は毎朝赤を見ることになり、そのうち見なくなる。
 * **赤が意味を持つのは、赤でないときがある場合だけ**である。
 */
export const OPERATIONS_COPY = {
  title: '運営の状況',
  description: '今日の動きと、手当てが要ることをまとめています。',
  consistencyTitle: '記録の食い違い',
  consistencyDescription:
    '記録どうしのつじつまを確かめます。⚠️ ここでは直しません。見つけたものを一覧でお知らせします。',
  entitlementsTitle: '受取権',
  notificationsTitle: '知らせの送信履歴',
  allClear: '手当てが要ることはありません。',
  noFindings: '食い違いは見つかりませんでした。',
} as const;

/** 見出しの色。⚠️ `critical` だけが赤。 */
export function severityTone(severity: OperationsSeverity): StatusToneName {
  switch (severity) {
    case 'critical':
      return 'danger';
    case 'warning':
      return 'warning';
    case 'normal':
      return 'neutral';
  }
}

export function severityLabel(severity: OperationsSeverity): string {
  switch (severity) {
    case 'critical':
      return '要対応';
    case 'warning':
      return '確認';
    case 'normal':
      return '平常';
  }
}

/** 画面の先頭に出す一言。⚠️ 何をすればよいかを最初に伝える。 */
export function overallMessage(severity: OperationsSeverity): string {
  switch (severity) {
    case 'critical':
      return 'いま手当てが必要なものがあります。赤い項目からご確認ください。';
    case 'warning':
      return '急ぎではありませんが、今日中に確かめたいものがあります。';
    case 'normal':
      return OPERATIONS_COPY.allClear;
  }
}

/** 受取権の状態。⚠️ 内部の言葉をそのまま出さない。 */
export function entitlementStatusLabel(status: string): string {
  switch (status) {
    case 'issued':
      return 'お受け取り前';
    case 'claimed':
      return 'お受け取り済み';
    case 'revoked':
      return '取り消し済み';
    case 'expired':
      return '期限切れ';
    default:
      return status;
  }
}

/** ウォレットへのお届けの状態。 */
export function walletDeliveryLabel(status: string): string {
  switch (status) {
    case 'not_started':
      return '未着手';
    case 'pending':
      return 'お届け中';
    case 'delivered':
      return 'お届け済み';
    default:
      return status;
  }
}

/**
 * 知らせの種別の呼び名。
 *
 * ⚠️ **識別子をそのまま出さない。** `wallet.delivery_stalled` と書かれても、
 * 受け取った運営は何のことか分からない。
 */
export const NOTIFICATION_EVENT_LABELS: Readonly<Record<string, string>> = {
  'order.placed': 'ご注文の受付',
  'payment.succeeded': 'お支払いの確認',
  'payment.failed': 'お支払いの不成立',
  'payment.expired': 'お支払い期限切れ',
  'wallet.registration_requested': '受取用ウォレットのお願い',
  'entitlement.delivered': 'お届けの完了',
  'wallet.delivery_stalled': 'お届けの遅れのお詫び',
  'refund.requested': 'ご返金の手続き開始',
  'refund.completed': 'ご返金の完了',
};

export function notificationEventLabel(eventType: string): string {
  return NOTIFICATION_EVENT_LABELS[eventType] ?? eventType;
}

/** 知らせの状態。⚠️ `SENT` は「送信事業者が受け付けた」まで。到達ではない。 */
export function notificationStatusLabel(status: string): string {
  switch (status) {
    case 'PENDING':
      return '送信待ち';
    case 'PROCESSING':
      return '送信中';
    case 'SENT':
      return '送信済み';
    case 'FAILED':
      return '送信できず';
    case 'DEAD':
      return '送信を打ち切り';
    case 'SKIPPED':
      return '送信を見合わせ';
    default:
      return status;
  }
}

export function notificationStatusTone(status: string): StatusToneName {
  switch (status) {
    case 'SENT':
      return 'success';
    case 'DEAD':
      return 'danger';
    case 'FAILED':
      return 'warning';
    default:
      return 'neutral';
  }
}

/**
 * 指標の値の見せ方。
 *
 * ⚠️ **売上を「件」と書かない。** 数の欄をそのまま並べると、
 * 12000 円が「12000 件」になる。桁が大きいので気づきにくく、
 * 気づいたときには朝礼で読み上げられている。
 */
export function indicatorValue(key: string, count: number | null): string {
  if (count === null) {
    return '—';
  }
  if (key === 'today_paid_amount') {
    return `${count.toLocaleString('ja-JP')} 円`;
  }
  return `${count.toLocaleString('ja-JP')} 件`;
}

/** 日時。⚠️ JST で出す。UTC のまま出すと 9 時間ずれた時刻を信じられる。 */
export function formatJst(value: string | null): string {
  if (value === null) {
    return '—';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  const jst = new Date(date.getTime() + 9 * 60 * 60_000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(jst.getUTCFullYear())}/${pad(jst.getUTCMonth() + 1)}/${pad(jst.getUTCDate())} ${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}`;
}
