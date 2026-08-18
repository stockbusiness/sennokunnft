import type { WalletDeliveryView } from '@sengoku/contracts';
import type { StatusToneName } from '@sengoku/ui';

/**
 * 送信の運用画面と監査ログの文言（管理画面・外部連携 指示書 §5）。
 *
 * ⚠️ **Web3 用語も、内部の状態名も、そのまま出さない。**
 * `DEAD` を「デッド」と書いても運営には何も伝わらない。
 * 「何が起きていて、次に何をすればよいか」が分かる言葉にする。
 *
 * ⚠️ **内部の状態名は変えない。** 表示だけを言い換える。
 * DB の値まで日本語にすると、ログ・問い合わせ・コードが食い違う。
 */
export const DELIVERY_COPY = {
  title: 'お届けの状況',
  description:
    'お受け取りいただいた内容を、提携先のサービスへお届けした記録です。うまくいかなかったものは、この画面から送り直せます。',

  /**
   * ⚠️ **本文を出さない理由を、画面にも書く。** 書かないと
   * 「見られるようにしてほしい」という要望が繰り返し出る。
   */
  payloadNote: 'お届けした内容そのものは表示しません',
  payloadNoteHint:
    'お客さまの情報が含まれるためです。提携先へお問い合わせいただくときは、下の「お問い合わせ番号」をお伝えください。',

  countsHeading: '全体の件数',
  filterHeading: '絞り込み',
  filterStatus: '状態',
  filterEventId: 'お問い合わせ番号',
  filterEventIdHint: '完全に一致するものを探します。',
  submitFilter: 'この条件で表示する',
  submitClear: '条件を外す',

  columnStatus: '状態',
  columnEventId: 'お問い合わせ番号',
  columnAttempts: '試した回数',
  columnUpdated: '最終更新',
  columnError: 'うまくいかなかった理由',
  columnActions: ' ',

  submitResend: 'もう一度お届けする',
  submitResendSelected: '選んだものをもう一度お届けする',
  selectLabel: '選ぶ',

  noItems: '記録がありません',
  noItemsHint: 'まだお届けが行われていないか、絞り込みの条件に合うものがありません。',

  detailHeading: 'この記録の詳細',
  detailEventId: 'お問い合わせ番号',
  detailCorrelationId: '調査用の番号',
  detailEntitlementId: '受け取りの番号',
  detailTarget: 'お届け先',
  detailHash: '内容の照合値',
  detailHashHint:
    'お届けした内容そのものではなく、その内容から計算した値です。内容が変わっていないことの確認に使います。',
  detailNextRetry: '次に自動でお届けする予定',
  detailCreated: '記録した日時',
  detailDelivered: 'お届けできた日時',
  back: '一覧へ戻る',

  resendBlocked: 'この状態のものは送り直せません',
  resendBlockedHint:
    'お届け中のものと、すでにお届けできたものは送り直せません。お届け中のものは、しばらく待つと結果が確定します。',
} as const;

/**
 * 状態の短い言い換え。表の中の印に使う。
 *
 * ⚠️ **内部の値は変えない。** 表示だけを言い換える。
 *
 * ⚠️ **短くする理由は見た目ではない。** 表の中に長い文を入れると、
 * スマホ幅で一文字ずつ縦に割れて読めなくなる（実際にそうなった）。
 * 詳しい言い方は `deliveryStatusDescription` にある。
 */
export function deliveryStatusLabel(status: WalletDeliveryView['status']): string {
  switch (status) {
    case 'PENDING':
      return 'お届け待ち';
    case 'PROCESSING':
      return 'お届け中';
    case 'DELIVERED':
      return 'お届け済み';
    case 'FAILED':
      return 'お届けできず';
    case 'DEAD':
      return '打ち切り';
  }
}

/** 状態の詳しい言い換え。件数の見出しと詳細画面に使う。 */
export function deliveryStatusDescription(status: WalletDeliveryView['status']): string {
  switch (status) {
    case 'PENDING':
      return 'お届けを待っています';
    case 'PROCESSING':
      return 'お届けしています';
    case 'DELIVERED':
      return 'お届けできました';
    case 'FAILED':
      return 'お届けできませんでした';
    case 'DEAD':
      return '何度試してもお届けできませんでした';
  }
}

/**
 * 状態の色。
 *
 * ⚠️ **色に意味を持たせきらない。** `FAILED` と `DEAD` は運用ですることが
 * 違う（前者は直して送り直す、後者は相手の状況を確かめる）が、同じ色にしてある。
 * 色だけで区別すると、色の見え方が違う人には伝わらない。
 * 違いは言葉のほうで書いている。
 */
export function deliveryStatusTone(status: WalletDeliveryView['status']): StatusToneName {
  switch (status) {
    case 'DELIVERED':
      return 'success';
    case 'PENDING':
      return 'neutral';
    case 'PROCESSING':
      return 'progress';
    case 'FAILED':
    case 'DEAD':
      return 'warning';
  }
}

/**
 * 失敗の理由の言い換え。
 *
 * ⚠️ **知らない符号を推測で言い換えない。** 「通信の問題です」と
 * 決めつけると、実際は別の原因だったときに調査が遠回りになる。
 * 分からないものは符号のまま出す。
 */
export function deliveryErrorLabel(code: string | null): string {
  if (code === null) {
    return '';
  }
  switch (code) {
    case 'timeout':
      return '時間内に応答がありませんでした';
    case 'network':
      return '提携先へ接続できませんでした';
    default:
      break;
  }
  const status = /^http_(\d{3})$/.exec(code)?.[1];
  if (status === undefined) {
    return code;
  }
  if (status === '401' || status === '403') {
    return `提携先に断られました（${status}）。接続の設定をご確認ください`;
  }
  if (status === '429') {
    return `提携先が混み合っています（${status}）`;
  }
  if (status.startsWith('5')) {
    return `提携先で問題が起きています（${status}）`;
  }
  return `お届けの内容を受け付けてもらえませんでした（${status}）`;
}

/** 再送の結果の言い換え。 */
export function resendOutcomeLabel(outcome: string, count: number): string {
  switch (outcome) {
    case 'requeued':
      return `${String(count)} 件を送り直しました。少し経ってから状態をご確認ください。`;
    case 'not_resendable':
      return `${String(count)} 件は送り直せませんでした。お届け中のものと、すでにお届けできたものは送り直せません。`;
    case 'not_found':
      return `${String(count)} 件は見つかりませんでした。`;
    default:
      return '';
  }
}

/** 監査ログの文言。 */
export const AUDIT_COPY = {
  title: '操作の記録',
  description: '管理画面で行われた操作の記録です。新しいものから並びます。',

  filterAction: '操作の種類',
  filterActionHint: '先頭が一致するものを探します（例：staff）。',
  submitFilter: 'この条件で表示する',
  submitClear: '条件を外す',

  columnOccurredAt: '日時',
  columnActor: '操作した人',
  columnAction: '操作',
  columnTarget: '対象',
  columnSummary: '内容',

  actorSystem: '（自動）',
  noItems: '記録がありません',
  noItemsHint: '絞り込みの条件に合う記録がありません。',

  /**
   * ⚠️ **伏せたことを黙らない。** 何も言わずに伏せると、見た人は
   * 「記録されていない」と読む。記録はあるが見せていない、という違いは
   * 監査では重い。
   */
  redactedNote: 'メールアドレスは伏せて表示しています',
  redactedNoteHint: '記録そのものは残っています。必要なときはオーナーがご確認いただけます。',
} as const;

/**
 * 操作名の言い換え。
 *
 * ⚠️ **知らない操作名は、そのまま出す。** 一覧に無いものを
 * 「その他の操作」などにまとめると、新しい操作を足したときに
 * 記録が読めなくなったことに気づけない。
 */
const ACTION_LABELS: Readonly<Record<string, string>> = {
  'artwork.create': '作品を登録した',
  'artwork.update': '作品を直した',
  'artwork.publish': '作品を公開した',
  'artwork.archive': '作品の公開をやめた',
  'artwork.delete': '作品を消した',
  'artwork.image.replace': '作品の画像を入れ替えた',
  'listing.create': '販売を作った',
  'listing.update': '販売を直した',
  'listing.activate': '販売を始めた',
  'listing.suspend': '販売を一時停止した',
  'listing.end': '販売を終えた',
  'staff.invite': 'スタッフを招待した',
  'staff.invite.revoke': '招待を取り消した',
  'staff.invite.accept': '招待を受けた',
  'staff.update': 'スタッフの権限を変えた',
  'integration.update': '外部連携の設定を変えた',
  'integration.secret.register': '外部連携の資格情報を登録した',
  'integration.secret.activate': '外部連携の資格情報を有効にした',
  'integration.secret.discard': '外部連携の資格情報を捨てた',
  'integration.connection_check': '外部連携の接続を確かめた',
  'integration.enable': '外部連携を有効にした',
  'integration.disable': '外部連携を止めた',
  'claim_token.reissued': '受け取り用のリンクを出し直した',
  'wallet_delivery.resend': 'お届けを送り直した',
};

export function auditActionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

/** 日時をそのまま読める形にする。保存は UTC、表示は日本時間。 */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}
