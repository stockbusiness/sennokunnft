import type { AdminOrderView, OrderView } from '@sengoku/contracts';

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
