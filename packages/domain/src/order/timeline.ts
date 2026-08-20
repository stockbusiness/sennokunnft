import type { OrderView, PaymentAttemptView, WebhookReceiptRecord } from '../ports/order';

/**
 * 注文の経過（`UD-121`）。
 *
 * 問い合わせで最初に要るのは「いつ何が起きたか」を一列で見ることである。
 * いまは決済の試行と Webhook の受信記録が別々の表になっていて、
 * 目で突き合わせる必要がある。突き合わせを間違えると、
 * 起きていないことを起きたと答えることになる。
 *
 * ⚠️ **時刻の無い出来事を並べない。** 「期限切れになった」ことは
 * 状態から分かるが、いつ切れたかの記録は無い。それらしい時刻を
 * 埋めると、経過そのものが作り話になる。**分かることだけ並べる。**
 *
 * ⚠️ **これは読み取り専用の組み立てである。** ここから状態を変えない。
 * 経過に「取り消す」ボタンを生やしたくなったら、まず §9.3 の
 * 禁止事項を読み直すこと。
 */

export const ORDER_TIMELINE_KINDS = [
  /** 注文ができた。 */
  'order_created',
  /** 支払いの口を作った。 */
  'checkout_created',
  /** 支払いの口が閉じる時刻。⚠️ 未来の時刻も並べる（あと何分かが要る）。 */
  'checkout_expires',
  /** 支払いが成立した（決済事業者の記録）。 */
  'payment_succeeded',
  /** 注文が支払い済みになった（こちら側の確定）。 */
  'order_paid',
  /** 決済事業者から知らせが届いた。 */
  'webhook_received',
  /** 届いた知らせの処理が終わった。 */
  'webhook_processed',
  /** お取り置きが売上へ振り替わった。 */
  'reservation_consumed',
  /** お取り置きを解放した。 */
  'reservation_released',
  /** お取り置きの期限。 */
  'reservation_expires',
  /** 運営が残した対応メモ。 */
  'support_note',
] as const;
export type OrderTimelineKind = (typeof ORDER_TIMELINE_KINDS)[number];

/**
 * 同時刻に並んだときの順番。
 *
 * ⚠️ **決めておかないと、表示のたびに順番が変わる。** 秒までしか
 * 見えない画面では同時刻が普通に起きる。見るたびに入れ替わる経過は、
 * 「さっきと違う」という問い合わせを新たに生む。
 */
const KIND_ORDER: Readonly<Record<OrderTimelineKind, number>> = {
  order_created: 0,
  checkout_created: 1,
  checkout_expires: 2,
  webhook_received: 3,
  payment_succeeded: 4,
  order_paid: 5,
  webhook_processed: 6,
  reservation_consumed: 7,
  reservation_released: 8,
  reservation_expires: 9,
  support_note: 10,
};

export interface OrderTimelineEntry {
  readonly kind: OrderTimelineKind;
  readonly at: Date;
  /**
   * その行だけに要る補足。
   *
   * ⚠️ **秘匿値・購入者の個人情報を入れない。** 経過は問い合わせの
   * たびに開かれ、画面のまま読み上げられることもある。
   */
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;
}

/** 対応メモ 1 件ぶん（経過へ差し込むための最小の形）。 */
export interface OrderNoteEntry {
  readonly id: string;
  readonly authorAccountId: string;
  readonly body: string;
  readonly createdAt: Date;
}

export interface OrderTimelineInput {
  readonly order: OrderView;
  readonly attempts: readonly PaymentAttemptView[];
  readonly webhooks: readonly WebhookReceiptRecord[];
  readonly notes: readonly OrderNoteEntry[];
}

/**
 * 経過を古い順に組み立てる。
 *
 * ⚠️ **古い順である。** 一覧は新しい順だが、経過は「何が起きて、
 * 次に何が起きたか」を読むもので、逆順だと因果が逆に読める。
 */
export function buildOrderTimeline(input: OrderTimelineInput): readonly OrderTimelineEntry[] {
  const entries: OrderTimelineEntry[] = [];
  const { order } = input;

  entries.push({
    kind: 'order_created',
    at: order.createdAt,
    detail: {
      orderNumber: order.orderNumber,
      totalAmount: order.totalAmount,
      currency: order.currency,
      // ⚠️ 作品名は注文時点のもの。マスタを引き直さない（スナップショット原則）。
      title: order.item?.titleSnapshot ?? null,
    },
  });

  if (order.paidAt !== null) {
    entries.push({ kind: 'order_paid', at: order.paidAt, detail: {} });
  }

  const { reservation } = order;
  if (reservation !== null) {
    entries.push({
      kind: 'reservation_expires',
      at: reservation.expiresAt,
      detail: { quantity: reservation.quantity, status: reservation.status },
    });
    if (reservation.consumedAt !== null) {
      entries.push({
        kind: 'reservation_consumed',
        at: reservation.consumedAt,
        detail: { quantity: reservation.quantity },
      });
    }
    if (reservation.releasedAt !== null) {
      entries.push({
        kind: 'reservation_released',
        at: reservation.releasedAt,
        detail: { quantity: reservation.quantity },
      });
    }
  }

  for (const attempt of input.attempts) {
    entries.push({
      kind: 'checkout_created',
      at: attempt.createdAt,
      detail: {
        provider: attempt.provider,
        status: attempt.status,
        amount: attempt.amount,
        currency: attempt.currency,
        // ⚠️ 支払いページの URL は出さない。持つ人は誰でも支払える。
        sessionRef: attempt.sessionRef,
        failureCode: attempt.failureCode,
      },
    });
    if (attempt.expiresAt !== null) {
      entries.push({
        kind: 'checkout_expires',
        at: attempt.expiresAt,
        detail: { provider: attempt.provider },
      });
    }
    if (attempt.paidAt !== null) {
      entries.push({
        kind: 'payment_succeeded',
        at: attempt.paidAt,
        detail: {
          provider: attempt.provider,
          amount: attempt.amount,
          currency: attempt.currency,
          // ⚠️ 事業者へ問い合わせるときに要る識別子。秘密ではない。
          paymentRef: attempt.paymentRef,
          chargeRef: attempt.chargeRef,
        },
      });
    }
  }

  for (const receipt of input.webhooks) {
    entries.push({
      kind: 'webhook_received',
      at: receipt.receivedAt,
      detail: {
        eventType: receipt.eventType,
        livemode: receipt.livemode,
        attemptCount: receipt.attemptCount,
      },
    });
    if (receipt.processedAt !== null) {
      entries.push({
        kind: 'webhook_processed',
        at: receipt.processedAt,
        detail: {
          eventType: receipt.eventType,
          status: receipt.status,
          // ⚠️ こちらで決めた符号のみ。事業者の文言をそのまま出さない。
          errorCode: receipt.lastErrorCode,
        },
      });
    }
  }

  for (const note of input.notes) {
    entries.push({
      kind: 'support_note',
      at: note.createdAt,
      // ⚠️ 誰が書いたかは識別子で持つ。氏名やメールを埋めない。
      detail: { noteId: note.id, authorAccountId: note.authorAccountId, body: note.body },
    });
  }

  return entries.sort(compareEntries);
}

function compareEntries(a: OrderTimelineEntry, b: OrderTimelineEntry): number {
  const byTime = a.at.getTime() - b.at.getTime();
  if (byTime !== 0) {
    return byTime;
  }
  return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
}
