/**
 * 購入者へ送る知らせの種別（実運営 指示書 P0-4）。
 *
 * ⚠️ **「送ってもよい知らせ」ではなく「送らなければならない知らせ」を並べてある。**
 * 買った方から見ると、お金が動いた・待ち時間が発生した・こちらの都合で
 * 状態が変わった、のいずれかが起きている。画面を開き直さないと分からない
 * 作りにすると、そのぶん問い合わせが増える。
 *
 * ⚠️ **種別を増やすときは、テンプレートの既定版も同時に用意する。**
 * 種別だけ足すと、送る段になって「文面が無い」で止まる。止まった知らせは
 * 誰にも気づかれないまま溜まる。
 */

/** 知らせの種別。DB の CHECK 制約と同じ語彙。 */
export const NOTIFICATION_EVENT_TYPES = [
  /** ご注文を受け付けた（お支払い前）。 */
  'order.placed',
  /** お支払いが確認できた。 */
  'payment.succeeded',
  /** お支払いが成立しなかった。 */
  'payment.failed',
  /** お支払いの期限が過ぎ、お取り置きを解いた。 */
  'payment.expired',
  /** 受取用のウォレットの登録をお願いする。 */
  'wallet.registration_requested',
  /** 作品のお受け取りが完了した。 */
  'entitlement.delivered',
  /**
   * お届けが長く滞っている。
   *
   * ⚠️ **黙って待たせない。** こちらの都合で止まっているときに何も言わないと、
   * 買った方は「買えていないのかもしれない」と考える。
   */
  'wallet.delivery_stalled',
  /** ご返金の手続きを始めた。 */
  'refund.requested',
  /** ご返金が完了した。 */
  'refund.completed',
] as const;
export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

export function isNotificationEventType(value: string): value is NotificationEventType {
  return (NOTIFICATION_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * 知らせが指している業務対象。
 *
 * ⚠️ **重複送信を止める鍵の一部。** 「どの種別を・どれについて」送ったかで
 * 一意にする。注文IDだけで一意にすると、同じ注文の決済成功と返金完了が
 * ぶつかる。
 */
export const NOTIFICATION_SUBJECT_TYPES = ['order', 'entitlement', 'refund'] as const;
export type NotificationSubjectType = (typeof NOTIFICATION_SUBJECT_TYPES)[number];

/** その種別が指す対象の種類。⚠️ 送る側で取り違えないよう、ここで固定する。 */
const SUBJECT_OF: Readonly<Record<NotificationEventType, NotificationSubjectType>> = {
  'order.placed': 'order',
  'payment.succeeded': 'order',
  'payment.failed': 'order',
  'payment.expired': 'order',
  'wallet.registration_requested': 'order',
  'entitlement.delivered': 'entitlement',
  'wallet.delivery_stalled': 'entitlement',
  'refund.requested': 'refund',
  'refund.completed': 'refund',
};

export function subjectTypeOf(eventType: NotificationEventType): NotificationSubjectType {
  return SUBJECT_OF[eventType];
}

/**
 * 文面へ差し込んでよい語。
 *
 * ⚠️ **ここに無い語をテンプレートへ書けないようにする。** 書けてしまうと、
 * 送る段になって空欄のまま出るか、`{{ }}` がそのまま届く。どちらも
 * 受け取った方には「壊れたメール」にしか見えない。
 *
 * ⚠️ **氏名・メールアドレス・住所を語彙に入れない**（`UD-503`）。
 * 入れられるようにすると、いつか誰かが本文へ入れ、送信履歴に残る。
 * **語彙に無ければ、書きようがない。**
 */
export const NOTIFICATION_VARIABLES: Readonly<Record<NotificationEventType, readonly string[]>> = {
  'order.placed': ['orderNumber', 'totalAmount', 'payUrl', 'expiresAt'],
  'payment.succeeded': ['orderNumber', 'totalAmount', 'orderUrl'],
  'payment.failed': ['orderNumber', 'orderUrl'],
  'payment.expired': ['orderNumber', 'orderUrl'],
  'wallet.registration_requested': ['orderNumber', 'walletUrl'],
  'entitlement.delivered': ['orderNumber', 'artworkTitle', 'serialNumber', 'collectionUrl'],
  'wallet.delivery_stalled': ['orderNumber', 'artworkTitle', 'contactUrl'],
  'refund.requested': ['orderNumber', 'orderUrl'],
  'refund.completed': ['orderNumber', 'refundAmount', 'orderUrl'],
};

/** すべての種別で共通して使える語。⚠️ 事業者名は文面ごとに変えない。 */
export const COMMON_NOTIFICATION_VARIABLES: readonly string[] = ['siteName', 'siteUrl'];

/** その種別で使ってよい語の一覧（共通の語を含む）。 */
export function allowedVariables(eventType: NotificationEventType): readonly string[] {
  return [...COMMON_NOTIFICATION_VARIABLES, ...NOTIFICATION_VARIABLES[eventType]];
}
