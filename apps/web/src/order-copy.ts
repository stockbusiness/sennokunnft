import type { AdminOrderView, OrderTimelineEntryView, OrderView } from '@sengoku/contracts';

/**
 * 注文まわりの文言。
 *
 * ⚠️ **購入画面に Web3 の言葉を出さない**（指示書 §8）。
 * 「ミント」「ウォレット」「ブロックチェーン」「トークン」は使わない。
 * 利用者は 60 代の方が中心で、聞き慣れない言葉が 1 つ混ざるだけで
 * 「自分には難しい」と手を止めてしまう。
 *
 * ⚠️ **エラーの符号を画面に出さない。** 出すのは「次に何をすればよいか」。
 * `IDEMPOTENCY_CONFLICT` と書かれても、利用者にできることは何も無い。
 */

export const ORDER_COPY = {
  // --- 購入手続き -----------------------------------------------------------
  checkoutTitle: 'ご注文内容の確認',
  checkoutDescription: '内容をお確かめのうえ、下のボタンをお押しください。',
  checkoutItemHeading: 'お申し込みの品',
  checkoutPriceLabel: 'お支払い金額',
  checkoutTaxNote: '（税込）',
  checkoutQuantityLabel: '数量',
  checkoutQuantityValue: '1点',
  submitCheckout: 'この内容で申し込む',
  submittingCheckout: '手続きをしています…',
  /**
   * ⚠️ **「購入」と言い切らない。** この時点ではまだお支払いが済んでいない。
   * 済んだように読める言葉を置くと、支払わないまま届くと思われる。
   */
  checkoutReserveNote: 'お申し込み後、30分間お取り置きします。',
  checkoutReserveHint: 'その間にお支払いのご案内をいたします。',

  loginRequiredTitle: 'お申し込みにはログインが必要です',
  loginRequiredHint: 'メールアドレスをお知らせいただくと、ログイン用のリンクをお送りします。',
  loginLink: 'ログインのページへ進む',

  soldOutTitle: 'ただいまお取り扱いがありません',
  soldOutHint: '売り切れ、または販売を終えた作品です。',
  notFoundTitle: 'お探しの作品が見つかりませんでした',
  notFoundHint: '一覧からもう一度お選びください。',

  // --- 決済準備中 -----------------------------------------------------------
  pendingTitle: 'お申し込みを承りました',
  /**
   * ⚠️ **「完了しました」と書かない。** お支払いはまだ済んでいない。
   * 済んだと読める言葉を置くと、あとで督促することになる。
   */
  pendingDescription: 'お支払いのご案内は、準備ができ次第このページに表示します。',
  pendingPreparingTitle: 'ただいまお支払いのご用意をしています',
  pendingPreparingHint:
    'お支払いの受付は準備中です。ご案内できるようになりましたら、あらためてお知らせします。',
  orderNumberLabel: '注文番号',
  orderNumberHint: 'お問い合わせの際にお伝えください。',
  reservedUntilLabel: 'お取り置きの期限',
  orderedAtLabel: 'お申し込み日時',
  backToCatalog: '作品の一覧へ戻る',

  expiredTitle: 'お取り置きの期限が過ぎました',
  expiredHint: 'お手数ですが、はじめからお申し込みください。',

  retryTitle: 'ただいまお手続きできませんでした',
  retryHint: '少し時間をおいて、もう一度お試しください。',

  // --- お支払い（決済 Phase P2） -------------------------------------------
  /**
   * ⚠️ **「購入完了」と書けるのは、決済会社からの通知を受けたあとだけ**
   * （指示書 §12）。ブラウザが戻ってきただけでは書かない。
   */
  payTitle: 'お支払いへお進みください',
  payDescription: 'お支払いのページへ移ります。カード情報はそちらでご入力ください。',
  submitPay: 'お支払いへ進む',
  submittingPay: 'お支払いのご用意をしています…',
  payReuseNote: '先ほどのお支払いページへ、もう一度お進みいただけます。',

  /** 戻ってきた直後。⚠️ まだ確定していない。 */
  confirmingTitle: 'お支払いの結果を確認しています',
  confirmingHint: 'そのままお待ちください。自動で切り替わります。',
  /** 待っても確定しないとき。⚠️ 「失敗しました」と言い切らない。 */
  confirmingSlowTitle: '確認に時間がかかっています',
  confirmingSlowHint:
    'お支払いは受け付けられている場合があります。このページを開いたままお待ちいただくか、時間をおいてもう一度ご確認ください。',

  paidTitle: 'ご購入ありがとうございます',
  paidDescription: '作品をご用意しています。準備が整いましたらお知らせします。',

  payFailedTitle: 'お支払いを完了できませんでした',
  /** ⚠️ 拒否の理由を具体的に出さない（指示書 §8）。次の行動だけを示す。 */
  payFailedRetryHint: 'お取り置き時間内であれば、もう一度お試しいただけます。',
  payFailedExpiredHint: 'お取り置き時間が終了しました。作品ページからやり直してください。',

  payExpiredTitle: 'お取り置き時間が終了しました',
  payExpiredHint: '作品ページから購入手続きをやり直してください。',

  /** ⚠️ 内部の設定値を見せない（決定 C）。 */
  setupIncompleteTitle: '購入の準備を行っています',
  setupIncompleteHint: 'しばらくしてからもう一度お試しください。',

  // --- 運営の決済表示（指示書 §13） ----------------------------------------
  adminPaymentsHeading: 'お支払いの記録',
  adminWebhooksHeading: '決済会社からの通知',
  adminNoPayments: 'お支払いの記録はまだありません',
  adminNoWebhooks: '通知はまだ届いていません',
  columnAttemptStatus: '状態',
  columnSessionRef: 'お支払いページの番号',
  columnPaymentRef: 'お支払いの番号',
  columnChargeRef: '受領の番号',
  columnAttemptAmount: '金額',
  columnAttemptExpires: '期限',
  columnAttemptCreated: '作成',
  columnFailureCode: '失敗の理由',
  columnEventType: '種類',
  columnWebhookStatus: '処理',
  columnLivemode: '区分',
  columnReceivedAt: '受信',
  columnAttemptCount: '受信回数',
  amountMatchesLabel: '金額の一致',
  amountMatchesYes: '一致しています',
  amountMatchesNo: '一致していません（要確認）',
  amountMatchesUnknown: 'まだ受領がありません',
  livemodeTest: 'テスト',
  livemodeLive: '本番',

  // --- 運営の注文一覧・詳細 -------------------------------------------------
  adminTitle: '注文の管理',
  adminDescription: '受け付けた注文の一覧です。金額と状態は変更できません。',
  adminNoOrders: 'まだ注文がありません',
  adminNoOrdersHint: '販売を開始すると、ここに並びます。',
  adminReadOnlyTitle: 'この画面から注文を書き換えることはできません',
  adminReadOnlyHint:
    '金額の修正、お支払い済みへの変更、注文の削除は行えません。お支払いの確定は決済会社からの通知だけが行います。',
  columnOrderNumber: '注文番号',
  columnOrderedAt: 'お申し込み',
  columnBuyer: 'ご購入者',
  columnItem: '作品',
  columnCreator: '出品者',
  columnAmount: '金額',
  columnOrderStatus: '注文',
  columnPaymentStatus: 'お支払い',
  columnFulfillmentStatus: 'お渡し',
  columnReservedUntil: '取り置き期限',
  detailHeading: '注文の内容',
  detailAmountsHeading: '金額の内訳',
  detailReservationHeading: '在庫のお取り置き',
  detailRelatedHeading: '関連する記録',
  subtotalLabel: '小計',
  discountLabel: '値引き',
  totalLabel: '合計',
  platformFeeLabel: '手数料',
  creatorAmountLabel: '出品者へのお支払い',
  feeRateLabel: '手数料率',
  feeRateUndecided: '未設定（0%）',
  feeRateUndecidedHint: '手数料率はまだ決まっていません。決まるまで 0% で記録しています。',
  paymentPresent: 'あり',
  paymentAbsent: 'なし',
  entitlementCountLabel: '受取り権利',
  idempotencyLabel: '重複防止キー（先頭）',
  idempotencyHint: '同じお申し込みが二重に届いていないかを確かめるための記号です。',
  reservationNone: 'お取り置きの記録はありません',
  backToOrders: '← 注文の一覧へ戻る',

  // --- 検索と問い合わせ対応（`UD-121`）-------------------------------------
  searchHeading: '注文をお探しする',
  searchHint:
    '分かっているものだけ入れてください。空の欄は絞り込みに使いません。「先週このくらいの金額で」からでも辿れます。',
  searchOrderNumber: '注文番号',
  searchOrderNumberHint:
    '末尾の8文字だけでも探せます。お電話ではそこだけ控えられることが多いためです。',
  searchCreatedFrom: 'お申し込み日（から）',
  searchCreatedTo: 'お申し込み日（まで）',
  searchMinAmount: '金額（下限・円）',
  searchMaxAmount: '金額（上限・円）',
  searchArtworkTitle: '作品名（一部でも可）',
  searchStatus: '注文の状態',
  searchPaymentStatus: 'お支払いの状態',
  searchAnyStatus: 'すべて',
  searchSubmit: 'この条件でさがす',
  searchClear: '条件をすべて消す',
  searchNoHits: 'この条件に当てはまる注文はありませんでした',
  searchNoHitsHint: '条件を減らしてお試しください。日付の範囲を広げると見つかることがあります。',

  emailLookupHeading: 'メールアドレスからさがす',
  /**
   * ⚠️ **「保存していない」ことを、対応する人にきちんと伝える。**
   * 伝えないと「検索できないのは不具合だ」と受け取られ、
   * 保存する方向へ直そうとする人が現れる（`UD-503`）。
   */
  emailLookupHint:
    'ご本人からうかがったメールアドレスを入れてください。当方ではメールアドレスそのものを保存していないため、その場で照合します。一覧には表示されません。',
  emailLookupLabel: 'メールアドレス',
  emailLookupSubmit: 'このアドレスでさがす',
  emailLookupUnavailable: 'この環境ではメールアドレスからのお調べができません',
  emailLookupUnavailableHint:
    '照合用の設定が入っていません。注文番号・期間・金額でお探しください。',

  timelineHeading: '経過',
  timelineHint: '古い順に並んでいます。お問い合わせのとき、上から順にお読みください。',
  timelineEmpty: '記録がまだありません',

  notesHeading: '対応メモ',
  /**
   * ⚠️ **消せないことを先に伝える。** 書いてから知ると、
   * 「消せないなら書かない」になり、記録が残らなくなる。
   */
  notesHint:
    'どなたが、どのように対応したかを残します。あとから消したり直したりはできません。訂正は新しいメモでお願いします。',
  notesEmailWarning:
    'メールアドレスは書かないでください（保存しない決まりのため、保存できません）。',
  notesEmpty: 'まだ対応メモはありません',
  notesLabel: '対応の内容',
  notesSubmit: 'メモを残す',
  notesSubmitting: '保存しています…',
  notesAuthorLabel: '記入者',
} as const;

const ORDER_STATUS_LABELS: Readonly<Record<OrderView['status'], string>> = {
  pending: 'お支払い待ち',
  checkout_created: 'お支払い手続き中',
  paid: 'お支払い済み',
  expired: '期限切れ',
  cancelled: '取り消し',
};

const PAYMENT_STATUS_LABELS: Readonly<Record<OrderView['paymentStatus'], string>> = {
  not_started: '未着手',
  pending: '手続き中',
  succeeded: '完了',
  failed: '失敗',
  cancelled: '取り消し',
  refunded: '返金済み',
};

const FULFILLMENT_STATUS_LABELS: Readonly<Record<OrderView['fulfillmentStatus'], string>> = {
  not_started: '未着手',
  processing: '手続き中',
  fulfilled: 'お渡し済み',
  failed: '失敗',
};

const REFUND_STATUS_LABELS: Readonly<Record<AdminOrderView['refundStatus'], string>> = {
  none: 'なし',
  pending: '手続き中',
  partially_refunded: '一部返金',
  refunded: '返金済み',
  failed: '失敗',
};

const RESERVATION_STATUS_LABELS: Readonly<Record<'reserved' | 'consumed' | 'released', string>> = {
  reserved: 'お取り置き中',
  consumed: '確定済み',
  released: '解放済み',
};

export function orderStatusLabel(status: OrderView['status']): string {
  return ORDER_STATUS_LABELS[status];
}

export function paymentStatusLabel(status: OrderView['paymentStatus']): string {
  return PAYMENT_STATUS_LABELS[status];
}

export function fulfillmentStatusLabel(status: OrderView['fulfillmentStatus']): string {
  return FULFILLMENT_STATUS_LABELS[status];
}

export function refundStatusLabel(status: AdminOrderView['refundStatus']): string {
  return REFUND_STATUS_LABELS[status];
}

export function reservationStatusLabel(status: 'reserved' | 'consumed' | 'released'): string {
  return RESERVATION_STATUS_LABELS[status];
}

/** 一覧の色。⚠️ 色だけで区別させない。文字の札と併せて使う。 */
export function orderStatusTone(status: OrderView['status']): 'success' | 'warning' | 'neutral' {
  if (status === 'paid') return 'success';
  if (status === 'expired' || status === 'cancelled') return 'warning';
  return 'neutral';
}

/**
 * 日時の表記。
 *
 * ⚠️ **画面には日本時間で出す。** 保存は UTC だが、
 * 「23時までお取り置き」が 14時 と出ると、利用者は諦めてしまう。
 */
export function formatDateTime(iso: string | null): string {
  if (iso === null) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/**
 * 手数料率の表記。bps を人が読む形にする。
 *
 * ⚠️ **浮動小数点で計算しない。** 表示のためだけに割り算をすると、
 * いつか金額の計算に流用される。整数の桁の入れ替えで作る。
 */
export function formatFeeRate(bps: number): string {
  if (bps === 0) return ORDER_COPY.feeRateUndecided;
  const whole = Math.trunc(bps / 100);
  const fraction = bps % 100;
  return fraction === 0
    ? `${String(whole)}%`
    : `${String(whole)}.${String(fraction).padStart(2, '0')}%`;
}

/**
 * 識別子の先頭だけ。
 *
 * ⚠️ **一覧に全体を並べない。** 一覧で見たいのは「同じ人か」であって、
 * 識別子そのものではない。36 文字の値が 1 行ずつ並ぶと、
 * 本当に読みたい注文番号と金額が押し出される。
 */
export function shortId(value: string): string {
  return value.slice(0, 8);
}

const ATTEMPT_STATUS_LABELS: Readonly<Record<string, string>> = {
  pending: 'お支払い待ち',
  succeeded: '完了',
  failed: '失敗',
  cancelled: '取り消し',
  refunded: '返金済み',
};

const WEBHOOK_STATUS_LABELS: Readonly<Record<string, string>> = {
  received: '受信のみ',
  processed: '処理済み',
  ignored: '対象外',
  failed: '処理できず',
};

export function attemptStatusLabel(status: string): string {
  return ATTEMPT_STATUS_LABELS[status] ?? status;
}

export function webhookStatusLabel(status: string): string {
  return WEBHOOK_STATUS_LABELS[status] ?? status;
}

/**
 * 失敗の理由を、買う人に見せてよい言葉にする。
 *
 * ⚠️ **決済会社の符号をそのまま出さない**（指示書 §12）。
 * `card_declined` と出しても、利用者にできることは何も無い。
 * 出すのは「次に何をすればよいか」だけ。
 */
export function payFailureHint(reservationExpired: boolean): string {
  return reservationExpired ? ORDER_COPY.payFailedExpiredHint : ORDER_COPY.payFailedRetryHint;
}

const TIMELINE_KIND_LABELS: Readonly<Record<OrderTimelineEntryView['kind'], string>> = {
  order_created: 'お申し込みを受け付けました',
  checkout_created: 'お支払いのご案内を作りました',
  checkout_expires: 'お支払いのご案内の期限',
  payment_succeeded: '決済会社でお支払いが成立しました',
  order_paid: 'お支払い済みになりました',
  webhook_received: '決済会社からの知らせが届きました',
  webhook_processed: '決済会社からの知らせを処理しました',
  reservation_consumed: 'お取り置きを確定しました',
  reservation_released: 'お取り置きを解放しました',
  reservation_expires: 'お取り置きの期限',
  support_note: '対応メモ',
};

export function timelineKindLabel(kind: OrderTimelineEntryView['kind']): string {
  return TIMELINE_KIND_LABELS[kind];
}

/**
 * 経過の 1 行を、人が読める補足へ落とす。
 *
 * ⚠️ **識別子をそのまま並べない。** 運営が見るのは「何が起きたか」で、
 * 内部の値は詳細の表にすでに出ている。ここへ全部写すと、
 * 経過が読み物ではなくなる。
 */
export function timelineDetailText(entry: OrderTimelineEntryView): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(entry.detail)) {
    if (value === null || value === '') continue;
    const label = TIMELINE_DETAIL_LABELS[key];
    if (label === undefined) continue;
    parts.push(`${label}: ${String(value)}`);
  }
  return parts.join(' / ');
}

const TIMELINE_DETAIL_LABELS: Readonly<Record<string, string>> = {
  orderNumber: '注文番号',
  title: '作品',
  totalAmount: '金額',
  amount: '金額',
  currency: '通貨',
  quantity: '数量',
  provider: '決済会社',
  status: '状態',
  eventType: '知らせの種類',
  failureCode: '失敗の理由',
  errorCode: '失敗の理由',
  attemptCount: '受信回数',
  sessionRef: '受付番号',
  paymentRef: 'お支払い番号',
  chargeRef: '請求番号',
  // ⚠️ `body` と `authorAccountId` はここに載せない。
  //    対応メモは専用の見せ方（`notes`）で出す。
};

/**
 * 返金の画面文言（`UD-104` / `UD-120`）。
 *
 * ⚠️ **「返金できません」で終わらせない。** 発行が進んだ注文は機械が
 * 決めないだけで、判断のうえで返すことはある。断りの言葉にすると、
 * 運営が「制度上できない」と誤って購入者に伝える。
 */
export const REFUND_COPY = {
  heading: '返金',
  /** ⚠️ 取り消せないことを、押す前に必ず書く。 */
  warning: '返金は取り消せません',
  hint: 'お戻しするのは、まだお返ししていない全額です。金額を指定しての一部返金は、この画面からは行いません。',

  reasonLabel: '返金の理由',
  reasonBuyerRequest: 'ご購入者さまからのお申し出',
  reasonOurFault: '当方の不具合',
  /** ⚠️ 期限の外でも受けることを、選ぶ前に伝える。 */
  reasonOurFaultHint: '当方の不具合が原因の場合は、お受けする期間を過ぎていてもお戻しします。',

  noteLabel: '対応の記録（任意）',
  noteHint: '⚠️ ご購入者さまには表示されません。メールアドレスは書かないでください。',

  confirmLabel: '確認のため、下の欄に「返金」と入力してください',
  confirmWord: '返金',
  confirmMismatch: '「返金」と入力されていないため、何もしていません。',

  submit: 'この注文を返金する',
  submitting: '返金しています…',

  acknowledgeLabel: '発行が進んでいることを承知のうえで返金する',
  acknowledgeHint:
    'この作品はすでにお渡ししているか、お渡しの処理が進んでいます。お戻ししても作品はお手元に残ります。',

  listHeading: 'これまでの返金',
  listEmpty: 'まだ返金はありません',
  initiatedByAdmin: '運営の操作',
  initiatedByProvider: '決済事業者の画面から',
  statusRequested: '依頼済み（未確定）',
  statusSucceeded: '完了',
  statusFailed: '失敗',

  /** ⚠️ 取り消せなかった発行ジョブ。丸めずに伝える。 */
  annotatedWarning: 'お渡しの処理を取り消せませんでした',
  annotatedHint:
    '外部へ送信済みの可能性があるため、取り消さずに記録だけ残しました。二重にお渡ししていないかをご確認ください。',
  succeeded: '返金しました。',
} as const;

export function refundRecordStatusLabel(status: string): string {
  if (status === 'succeeded') return REFUND_COPY.statusSucceeded;
  if (status === 'failed') return REFUND_COPY.statusFailed;
  return REFUND_COPY.statusRequested;
}

export function refundReasonLabel(reason: string): string {
  if (reason === 'our_fault') return REFUND_COPY.reasonOurFault;
  if (reason === 'provider_initiated') return REFUND_COPY.initiatedByProvider;
  return REFUND_COPY.reasonBuyerRequest;
}
