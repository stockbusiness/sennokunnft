import { Injectable } from '@nestjs/common';
import type { NotificationOutboxPort } from '@sengoku/domain';
import { NotificationService } from './notification.service';

/**
 * 業務の出来事を、購入者への知らせへ翻訳する（P0-4）。
 *
 * ⚠️ **差し込む値をここに集める。** 呼ぶ側（注文・決済・返金）に散らすと、
 * 同じ「注文番号」が場所によって違う書き方になる。1 か所にまとめておけば、
 * 語彙を増やすときも直すのは 1 か所で済む。
 *
 * ⚠️ **どのメソッドも例外を投げない。** 呼び出し元は業務の
 * トランザクションの中にいる。知らせが積めないことでそこを巻き戻さない。
 */
@Injectable()
export class BuyerNotifier {
  constructor(
    private readonly notifications: NotificationService,
    private readonly config: { readonly siteUrl: string },
  ) {}

  /** ご注文を承った（お支払い前）。 */
  orderPlaced(
    input: {
      readonly orderId: string;
      readonly accountId: string;
      readonly orderNumber: string;
      readonly totalAmount: number;
      readonly currency: string;
      readonly expiresAt: Date;
    },
    executor?: Parameters<NotificationOutboxPort['enqueue']>[1],
  ): Promise<unknown> {
    return this.notifications.enqueue(
      {
        eventType: 'order.placed',
        subjectId: input.orderId,
        accountId: input.accountId,
        values: {
          orderNumber: input.orderNumber,
          totalAmount: formatAmount(input.totalAmount, input.currency),
          // ⚠️ 決済事業者の URL ではない。注文の画面から進んでいただく。
          payUrl: this.orderUrl(input.orderId),
          expiresAt: formatJst(input.expiresAt),
        },
      },
      executor,
    );
  }

  /** お支払いを確認した。 */
  paymentSucceeded(
    input: {
      readonly orderId: string;
      readonly accountId: string;
      readonly orderNumber: string;
      readonly totalAmount: number;
      readonly currency: string;
    },
    executor?: Parameters<NotificationOutboxPort['enqueue']>[1],
  ): Promise<unknown> {
    return this.notifications.enqueue(
      {
        eventType: 'payment.succeeded',
        subjectId: input.orderId,
        accountId: input.accountId,
        values: {
          orderNumber: input.orderNumber,
          totalAmount: formatAmount(input.totalAmount, input.currency),
          orderUrl: this.orderUrl(input.orderId),
        },
      },
      executor,
    );
  }

  /** お支払いが成立しなかった。 */
  paymentFailed(
    input: { readonly orderId: string; readonly accountId: string; readonly orderNumber: string },
    executor?: Parameters<NotificationOutboxPort['enqueue']>[1],
  ): Promise<unknown> {
    return this.enqueueOrderOnly('payment.failed', input, executor);
  }

  /** お支払いの期限が過ぎ、お取り置きを解いた。 */
  paymentExpired(
    input: { readonly orderId: string; readonly accountId: string; readonly orderNumber: string },
    executor?: Parameters<NotificationOutboxPort['enqueue']>[1],
  ): Promise<unknown> {
    return this.enqueueOrderOnly('payment.expired', input, executor);
  }

  /** ご返金のお手続きを始めた。⚠️ 対象は返金 1 件（注文ではない）。 */
  refundRequested(
    input: {
      readonly refundId: string;
      readonly accountId: string;
      readonly orderId: string;
      readonly orderNumber: string;
    },
    executor?: Parameters<NotificationOutboxPort['enqueue']>[1],
  ): Promise<unknown> {
    return this.notifications.enqueue(
      {
        eventType: 'refund.requested',
        subjectId: input.refundId,
        accountId: input.accountId,
        values: {
          orderNumber: input.orderNumber,
          orderUrl: this.orderUrl(input.orderId),
        },
      },
      executor,
    );
  }

  /** ご返金が完了した。 */
  refundCompleted(
    input: {
      readonly refundId: string;
      readonly accountId: string;
      readonly orderId: string;
      readonly orderNumber: string;
      readonly refundAmount: number;
      readonly currency: string;
    },
    executor?: Parameters<NotificationOutboxPort['enqueue']>[1],
  ): Promise<unknown> {
    return this.notifications.enqueue(
      {
        eventType: 'refund.completed',
        subjectId: input.refundId,
        accountId: input.accountId,
        values: {
          orderNumber: input.orderNumber,
          refundAmount: formatAmount(input.refundAmount, input.currency),
          orderUrl: this.orderUrl(input.orderId),
        },
      },
      executor,
    );
  }

  /** 受取用のウォレットの登録をお願いする。⚠️ 対象は注文 1 件。 */
  walletRegistrationRequested(
    input: { readonly orderId: string; readonly accountId: string; readonly orderNumber: string },
    executor?: Parameters<NotificationOutboxPort['enqueue']>[1],
  ): Promise<unknown> {
    return this.notifications.enqueue(
      {
        eventType: 'wallet.registration_requested',
        subjectId: input.orderId,
        accountId: input.accountId,
        values: {
          orderNumber: input.orderNumber,
          walletUrl: `${this.config.siteUrl}/account/settings`,
        },
      },
      executor,
    );
  }

  /** 作品のお受け取りが完了した。⚠️ 対象は受取権 1 枚。 */
  entitlementDelivered(
    input: {
      readonly entitlementId: string;
      readonly accountId: string;
      readonly orderNumber: string;
      readonly artworkTitle: string;
      readonly serialNumber: string;
    },
    executor?: Parameters<NotificationOutboxPort['enqueue']>[1],
  ): Promise<unknown> {
    return this.notifications.enqueue(
      {
        eventType: 'entitlement.delivered',
        subjectId: input.entitlementId,
        accountId: input.accountId,
        values: {
          orderNumber: input.orderNumber,
          artworkTitle: input.artworkTitle,
          serialNumber: input.serialNumber,
          collectionUrl: `${this.config.siteUrl}/account/collectibles`,
        },
      },
      executor,
    );
  }

  /** お届けが長く滞っている。⚠️ 対象は受取権 1 枚。 */
  walletDeliveryStalled(
    input: {
      readonly entitlementId: string;
      readonly accountId: string;
      readonly orderNumber: string;
      readonly artworkTitle: string;
    },
    executor?: Parameters<NotificationOutboxPort['enqueue']>[1],
  ): Promise<unknown> {
    return this.notifications.enqueue(
      {
        eventType: 'wallet.delivery_stalled',
        subjectId: input.entitlementId,
        accountId: input.accountId,
        values: {
          orderNumber: input.orderNumber,
          artworkTitle: input.artworkTitle,
          // ⚠️ 連絡先を文面へ直に書かない。2 か所に書くと必ず食い違う。
          contactUrl: `${this.config.siteUrl}/legal/tokushoho`,
        },
      },
      executor,
    );
  }

  private enqueueOrderOnly(
    eventType: 'payment.failed' | 'payment.expired',
    input: { readonly orderId: string; readonly accountId: string; readonly orderNumber: string },
    executor?: Parameters<NotificationOutboxPort['enqueue']>[1],
  ): Promise<unknown> {
    return this.notifications.enqueue(
      {
        eventType,
        subjectId: input.orderId,
        accountId: input.accountId,
        values: {
          orderNumber: input.orderNumber,
          orderUrl: this.orderUrl(input.orderId),
        },
      },
      executor,
    );
  }

  private orderUrl(orderId: string): string {
    return `${this.config.siteUrl}/account/orders/${orderId}`;
  }
}

/**
 * 金額の表記。
 *
 * ⚠️ **整数のまま扱う。** 円は小数を持たない。途中で割ると誤差が入る。
 * ⚠️ **税込であることを文面側で書く。** ここでは数字だけを整える。
 */
function formatAmount(amount: number, currency: string): string {
  if (currency === 'JPY') {
    return `${amount.toLocaleString('ja-JP')} 円`;
  }
  // ⚠️ 円以外は運用が始まっていない。桁区切りだけ付けて符号を添える。
  return `${amount.toLocaleString('ja-JP')} ${currency}`;
}

/**
 * 日時の表記（JST）。
 *
 * ⚠️ **保存は UTC、表示は JST。** 期限を UTC のまま出すと、
 * 受け取った方は 9 時間ずれた時刻を信じて手続きを逃す。
 */
function formatJst(value: Date): string {
  const jst = new Date(value.getTime() + 9 * 60 * 60_000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(jst.getUTCDate()).padStart(2, '0');
  const hh = String(jst.getUTCHours()).padStart(2, '0');
  const mm = String(jst.getUTCMinutes()).padStart(2, '0');
  return `${String(y)}年${m}月${d}日 ${hh}:${mm}`;
}

/**
 * 何もしない知らせ役。
 *
 * ⚠️ **本番の配線では使わない。** 既存の呼び出し側（主に試験）が
 * 知らせを気にせず組み立てられるようにするためだけのもの。
 * `AppModule` は必ず実体を渡す。
 */
export const NULL_NOTIFIER: BuyerNotifier = new BuyerNotifier(
  {
    enqueue: (): Promise<'skipped'> => Promise.resolve('skipped'),
  } as unknown as NotificationService,
  { siteUrl: '' },
);
