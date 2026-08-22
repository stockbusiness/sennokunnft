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
  /**
   * 法務文書を改めた（`UD-127`）。
   *
   * ⚠️ **再同意が要る改定のときだけ送る。** 誤字を直しただけで全員へ
   * 送ると、次に本当に大事な改定を送ったときに読まれなくなる。
   *
   * ⚠️ **「次のログインで同意していただきます」だけでは足りない。**
   * ログインしない方には、改まったこと自体が伝わらない。約束の中身が
   * 変わるのに、黙って変えたことになる。
   */
  'legal.revised',
  /**
   * お振込先が変わった（P1-3）。
   *
   * ⚠️ **お金の行き先が変わることを、ご本人へ知らせる。** 乗っ取られた側から
   * 見れば、いちばん実入りのある操作である。**気づけるのは本人だけ**なので、
   * 変えた本人にも必ず届ける（「押した本人だから要らない」ではない）。
   *
   * ⚠️ **新しい口座の情報は載せない。** 乗っ取った側がこのメールを見れば
   * 済むことになる。載せるのは「変わったこと」と「覚えが無ければご連絡を」
   * まで。
   */
  'payout_account.changed',
  /**
   * 返金のお申し出をお受けした（方針整理 2026-08-22）。
   *
   * ⚠️ **「ご返金します」と読めない文面にする。** お受けしたことと、
   * お返しすることは別である。ここを曖昧に書くと、断ったときに
   * 「話が違う」になる——そしてそれは、こちらの書き方が悪い。
   */
  'refund_request.received',
  /**
   * 返金のお申し出を承れなかった。
   *
   * ⚠️ **黙って終わらせない。** 申し出た方から見ると、返事が来ないのと
   * 断られたのは違う。返事が来なければ、何度でも問い合わせが来る。
   */
  'refund_request.rejected',
  /**
   * 作家さまへ事実確認をお願いする。
   *
   * ⚠️ **これが無いと、期限が意味を持たない。** ご回答の期限は営業日数で
   * 決まるのに、**ログインしない限り依頼が来たことに気づけない**。
   * 気づかないまま期限が過ぎ、運営が「回答が無いので進めた」と記録する
   * ——作家さまから見れば、聞かれてすらいない。
   *
   * ⚠️ **金額とご購入者さまを載せない。** 事実をお答えいただくのに要らず、
   * 載せると「いくら返るのか」を先に知ることになって回答が歪む。
   */
  'refund_inquiry.asked',
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
export const NOTIFICATION_SUBJECT_TYPES = [
  'order',
  'entitlement',
  'refund',
  /**
   * お振込先（P1-3）。⚠️ 対象は作家さまのアカウント。
   *
   * ⚠️ **版を持たない。** 変わるたびに知らせたいので、対象を固定すると
   * 2 回目以降が重複として捨てられる……が、**それは困らない**——
   * 対象IDに変更の時刻を含めることで、変更ごとに 1 通にする。
   */
  'payout_account',
  /**
   * 法務文書の版（`UD-127`）。
   *
   * ⚠️ **版そのものを指す。** 「利用規約」を指すと、改定のたびに同じ鍵に
   * なり、2 回目以降が重複として捨てられる。**版で分ければ、改定ごとに
   * 1 通ずつ届く。**
   */
  'legal_version',
  /**
   * 返金のお申し出（方針整理 2026-08-22）。
   *
   * ⚠️ **注文ではなく申し出を指す。** 注文を指すと、同じ注文で 2 度目の
   * お申し出をいただいたときに、重複として捨てられる。
   */
  'refund_request',
] as const;
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
  'legal.revised': 'legal_version',
  'payout_account.changed': 'payout_account',
  'refund_request.received': 'refund_request',
  'refund_request.rejected': 'refund_request',
  'refund_inquiry.asked': 'refund_request',
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
  /*
    ⚠️ **本文そのものを差し込ませない**（`UD-127`）。規約は長く、メールへ
       写すと版が 2 か所に増える。**読みに行く先**（`legalUrl`）を渡す。
    ⚠️ **`effectiveFrom` を渡す。** 「いつから変わるのか」が無い改定通知は、
       読んだ方が何もできない。
  */
  'legal.revised': ['documentName', 'effectiveFrom', 'legalUrl'],
  /*
    ⚠️ **新しい口座の情報を語彙に入れない。** 入れられるようにすると、
       いつか誰かが本文へ入れる。**語彙に無ければ、書きようがない。**
       乗っ取った側がこのメールを見れば済む、という形にしない。
  */
  'payout_account.changed': ['changedAt', 'contactUrl'],
  /*
    ⚠️ **金額を語彙に入れない**（方針整理 2026-08-22）。入れられるように
       すると、いつか誰かが本文へ入れ、**お受けした時点の額が約束に見える**。
       どれだけお返しするかは審査が決める。**語彙に無ければ、書きようがない。**
  */
  'refund_request.received': ['orderNumber', 'orderUrl'],
  /*
    ⚠️ **却下の理由を語彙に入れない。** 運営の記録は運営の言葉で書かれて
       いて、そのままお送りする文ではない。個別のご説明は、運営が別途
       ご連絡する。
  */
  'refund_request.rejected': ['orderNumber', 'contactUrl'],
  /*
    ⚠️ **金額とご購入者さまを語彙に入れない。** 事実をお答えいただくのに
       要らず、載せると「いくら返るのか」を先に知ることになって回答が歪む。
    ⚠️ **`dueAt` を渡す。** 期限の無いお願いは、後回しにされて当然である。
  */
  'refund_inquiry.asked': ['dueAt', 'inquiryUrl'],
};

/** すべての種別で共通して使える語。⚠️ 事業者名は文面ごとに変えない。 */
export const COMMON_NOTIFICATION_VARIABLES: readonly string[] = ['siteName', 'siteUrl'];

/** その種別で使ってよい語の一覧（共通の語を含む）。 */
export function allowedVariables(eventType: NotificationEventType): readonly string[] {
  return [...COMMON_NOTIFICATION_VARIABLES, ...NOTIFICATION_VARIABLES[eventType]];
}
