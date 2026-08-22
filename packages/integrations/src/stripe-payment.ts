import Stripe from 'stripe';
import {
  domainError,
  err,
  ok,
  toSafeDisputeReason,
  toSafeFailureCode,
  type CheckoutSessionCreated,
  type CreateCheckoutSessionInput,
  type DisputeStatus,
  type DomainError,
  type PaymentFactKind,
  type PaymentGatewayPort,
  type ProviderPaymentFact,
  type RefundExecuted,
  type RefundPaymentInput,
  type Result,
} from '@sengoku/domain';

/**
 * Stripe との境界（決済 Phase P2・指示書 §5.1）。
 *
 * ⚠️ **Stripe の型をこの外へ出さない。** SDK の型・Session そのもの・
 * イベントの本文全体・例外の文面は、すべてこのファイルで止める。
 * 出すと、事業者を替えるときにドメインごと書き直しになる。
 *
 * ⚠️ **例外を投げない。** 呼び出し側が `try` を書き忘れると、
 * Stripe の障害がそのまま 500 になり、例外の文面が応答に混ざりうる。
 * `Result` で返し、詳細はここで捨てる。
 */

export interface StripePaymentGatewayOptions {
  readonly secretKey: string;
  readonly webhookSecret: string;
  /** 固定した API バージョン。SDK の既定と合わせる。 */
  readonly apiVersion: string;
  /** `{ORDER_ID}` を注文IDへ置き換えて使う。 */
  readonly successUrlTemplate: string;
  readonly cancelUrlTemplate: string;
  /** 差し替え可能にしてあるのはテストのため。本番では省略する。 */
  readonly client?: Stripe;
}

const ORDER_ID_PLACEHOLDER = '{ORDER_ID}';

export class StripePaymentGateway implements PaymentGatewayPort {
  public readonly provider = 'stripe';
  private readonly stripe: Stripe;

  constructor(private readonly options: StripePaymentGatewayOptions) {
    this.stripe =
      options.client ??
      new Stripe(options.secretKey, {
        // ⚠️ 固定する。未指定だとアカウントの既定版が使われ、
        //    Stripe 側の更新でイベントの形が変わったときに黙って壊れる。
        apiVersion: options.apiVersion as Stripe.LatestApiVersion,
      });
  }

  async createCheckoutSession(
    input: CreateCheckoutSessionInput,
  ): Promise<Result<CheckoutSessionCreated, DomainError>> {
    try {
      const session = await this.stripe.checkout.sessions.create(
        {
          mode: 'payment',
          line_items: [
            {
              price_data: {
                currency: input.currency.toLowerCase(),
                // ⚠️ 注文時点のスナップショットを使う。マスタを引き直さない。
                product_data: { name: input.itemName },
                unit_amount: input.amount,
              },
              quantity: input.quantity,
            },
          ],
          /*
            ⚠️ **metadata に入れてよいのは注文IDと相関IDだけ**（指示書 §5.2）。
               メールアドレス・氏名・作品名などを入れない。metadata は
               Stripe のダッシュボードから誰でも読め、輸出もできる。
          */
          metadata: {
            order_id: input.orderId,
            ...(input.correlationId === null ? {} : { correlation_id: input.correlationId }),
          },
          // Payment Intent 側にも入れる。Intent だけが届くイベントがあるため。
          payment_intent_data: { metadata: { order_id: input.orderId } },
          success_url: this.resolveUrl(this.options.successUrlTemplate, input.orderId),
          cancel_url: this.resolveUrl(this.options.cancelUrlTemplate, input.orderId),
          expires_at: Math.floor(input.expiresAt.getTime() / 1000),
          /*
            ⚠️ **無断で機能を足さない**（指示書 §5.3）。
               自動税計算・割引コード・請求先住所や電話番号の収集は、
               どれも事業と法務の判断が要る。既定のまま置く。
          */
        },
        // ⚠️ Stripe 側の冪等キー。業務の冪等キーとは別物。
        { idempotencyKey: input.idempotencyKey },
      );

      if (session.url === null) {
        return err(domainError('PAYMENT_PROVIDER_ERROR', 'checkout session has no url'));
      }

      return ok({
        sessionRef: session.id,
        paymentRef: typeof session.payment_intent === 'string' ? session.payment_intent : null,
        url: session.url,
        expiresAt:
          session.expires_at === null || session.expires_at === undefined
            ? input.expiresAt
            : new Date(session.expires_at * 1000),
        // ⚠️ 同上。包む側が押す。
        credentialId: null,
      });
    } catch (error) {
      /*
        ⚠️ **例外の文面を持ち出さない。** Stripe の例外には要求の内容が
           含まれることがあり、そこには金額も metadata も入る。
           運用が知りたいのは「Stripe とのやり取りに失敗した」までで、
           詳しくは Stripe のダッシュボードで見るほうが正確。
      */
      return err(domainError('PAYMENT_PROVIDER_ERROR', safeErrorSummary(error)));
    }
  }

  async verifyAndParseWebhook(
    rawBody: Buffer,
    signatureHeader: string,
  ): Promise<Result<ProviderPaymentFact, DomainError>> {
    let event: Stripe.Event;
    try {
      // ⚠️ 生のバイト列を渡す。組み直した JSON では署名が合わない。
      event = this.stripe.webhooks.constructEvent(
        rawBody,
        signatureHeader,
        this.options.webhookSecret,
      );
    } catch {
      // ⚠️ 理由を分けない。「署名が古い」と「署名が違う」を区別して返すと、
      //    総当たりの手がかりになる。
      return err(domainError('WEBHOOK_SIGNATURE_INVALID', 'signature verification failed'));
    }

    return ok(toFact(event));
  }

  /**
   * 返金を投げる（`UD-120`）。
   *
   * ⚠️ **Charge ではなく Payment Intent を優先して指す。** Charge は
   * 決済のやり直しで増えることがあり、こちらが覚えている 1 本が
   * 最新とは限らない。Intent を指せば Stripe 側が最新の Charge を選ぶ。
   *
   * ⚠️ **`reason` をそのまま渡さない。** Stripe が受け付ける語彙は
   * 3 つだけで、こちらの符号とは別物。対応表で移す。
   */
  async refundPayment(input: RefundPaymentInput): Promise<Result<RefundExecuted, DomainError>> {
    const target =
      input.paymentRef !== null && input.paymentRef !== ''
        ? { payment_intent: input.paymentRef }
        : input.chargeRef !== null && input.chargeRef !== ''
          ? { charge: input.chargeRef }
          : null;
    if (target === null) {
      // 事業者側の識別子が無い決済は返せない。⚠️ 黙って成功にしない。
      return err(domainError('REFUND_PROVIDER_ERROR', 'no provider payment reference'));
    }

    try {
      const refund = await this.stripe.refunds.create(
        {
          ...target,
          // ⚠️ 金額を必ず指定する。省略すると Stripe は全額を返す。
          //    こちらが決めた額と食い違いうるので、明示する。
          amount: input.amount,
          ...(stripeReason(input.reason) === null
            ? {}
            : { reason: stripeReason(input.reason) as Stripe.RefundCreateParams.Reason }),
        },
        // ⚠️ 返金の記録の識別子から作る。再試行しても 1 回になる。
        { idempotencyKey: input.idempotencyKey },
      );

      return ok({
        refundRef: refund.id,
        // ⚠️ Stripe が実際に返した額。要求額をそのまま書き戻さない。
        amount: refund.amount,
        /*
          ⚠️ **`pending` を成功に丸めない。** 銀行振込の返金は日をまたぐ。
             丸めると、返っていないのに返した扱いの注文ができる。
             `requires_action` も同じ扱いにする（人の操作待ち）。
        */
        pending: refund.status === 'pending' || refund.status === 'requires_action',
      });
    } catch (error) {
      // ⚠️ 例外の文面を持ち出さない。返金の要求には金額が載る。
      return err(domainError('REFUND_PROVIDER_ERROR', safeErrorSummary(error)));
    }
  }

  private resolveUrl(template: string, orderId: string): string {
    // ⚠️ 戻り先に Stripe の秘密を含めない。注文IDだけを差し込む。
    return template.includes(ORDER_ID_PLACEHOLDER)
      ? template.replaceAll(ORDER_ID_PLACEHOLDER, encodeURIComponent(orderId))
      : template;
  }
}

/**
 * Stripe のイベントを、業務の 3 つの事象へ畳む（指示書 §6）。
 *
 * ⚠️ **イベント名ごとに注文を進めない。** 1 回の支払いについて
 * `checkout.session.completed` と `payment_intent.succeeded` の両方が届く。
 * 名前ごとに処理を書くと、同じ支払いで注文を 2 回進めることになる。
 */
export function toFact(event: Stripe.Event): ProviderPaymentFact {
  const base = {
    eventId: event.id,
    eventType: event.type,
    apiVersion: event.api_version ?? null,
    livemode: event.livemode,
    occurredAt: new Date(event.created * 1000),
    // ⚠️ 世代はアダプタが知らない。包む側（`ResolvingPaymentGateway`）が押す。
    credentialId: null,
    // 返金のときだけ埋まる。それ以外は `null`。
    refundRef: null,
    refundedTotal: null,
    // 争いのときだけ埋まる。それ以外は `null`。
    disputeRef: null,
    disputeStatus: null,
    disputeAmount: null,
    disputeReason: null,
  };

  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const session = event.data.object;
      /*
        ⚠️ **`completed` は「支払い済み」を意味しない。** 銀行振込などの
           後払いでは、Checkout が終わっても入金はまだ。`payment_status` を
           見ずに `paid` にすると、入金前に商品を渡すことになる。
      */
      const paid =
        session.payment_status === 'paid' || session.payment_status === 'no_payment_required';
      return {
        ...base,
        kind: paid ? 'succeeded' : 'ignored',
        orderId: readOrderId(session.metadata),
        sessionRef: session.id,
        paymentRef: typeof session.payment_intent === 'string' ? session.payment_intent : null,
        chargeRef: null,
        amount: session.amount_total,
        currency: session.currency,
        failureCode: null,
      };
    }

    case 'checkout.session.expired': {
      const session = event.data.object;
      return {
        ...base,
        kind: 'checkout_expired',
        orderId: readOrderId(session.metadata),
        sessionRef: session.id,
        paymentRef: typeof session.payment_intent === 'string' ? session.payment_intent : null,
        chargeRef: null,
        amount: session.amount_total,
        currency: session.currency,
        failureCode: null,
      };
    }

    case 'payment_intent.succeeded': {
      const intent = event.data.object;
      return {
        ...base,
        kind: 'succeeded',
        orderId: readOrderId(intent.metadata),
        sessionRef: null,
        paymentRef: intent.id,
        chargeRef: typeof intent.latest_charge === 'string' ? intent.latest_charge : null,
        // ⚠️ `amount_received` を使う。`amount` は請求しようとした額で、
        //    一部だけ受け取った場合に食い違う。
        amount: intent.amount_received,
        currency: intent.currency,
        failureCode: null,
      };
    }

    case 'payment_intent.payment_failed':
    case 'checkout.session.async_payment_failed': {
      const object = event.data.object;
      const intent = 'last_payment_error' in object ? object : null;
      return {
        ...base,
        kind: 'failed',
        orderId: readOrderId(object.metadata),
        sessionRef: 'payment_status' in object ? object.id : null,
        paymentRef: intent === null ? null : intent.id,
        chargeRef: null,
        amount: null,
        currency: null,
        // ⚠️ 許可リストを通す。カードの事情をそのまま保存しない。
        failureCode: toSafeFailureCode(intent?.last_payment_error?.code ?? null),
      };
    }

    case 'charge.refunded': {
      const charge = event.data.object;
      /*
        ⚠️ **こちらから投げたぶんも、事業者の画面から返したぶんも、同じ
           知らせで届く。** 運営が慌てて Stripe の画面から返金するのは
           実際に起きるので、両方を同じ形で受ける。
      */
      const latest = charge.refunds?.data[0] ?? null;
      return {
        ...base,
        kind: 'refunded',
        orderId: readOrderId(charge.metadata),
        sessionRef: null,
        paymentRef: typeof charge.payment_intent === 'string' ? charge.payment_intent : null,
        chargeRef: charge.id,
        // ⚠️ 元の決済額。返した額ではない。取り違えると全額判定が狂う。
        amount: charge.amount,
        currency: charge.currency,
        failureCode: null,
        refundRef: latest?.id ?? null,
        // ⚠️ 累計。今回ぶんではない。
        refundedTotal: charge.amount_refunded,
      };
    }

    case 'charge.dispute.created':
    case 'charge.dispute.updated':
    case 'charge.dispute.closed':
    case 'charge.dispute.funds_withdrawn':
    case 'charge.dispute.funds_reinstated': {
      const dispute = event.data.object;
      /*
        ⚠️ **イベント名で決着を判断しない。** `closed` が届いても、
           勝ったのか負けたのかは `status` にしか書いていない。名前で
           分けると、勝った争いを返金として記録することになる。

        ⚠️ **`funds_withdrawn` を敗訴と読まない。** 引き落としは審理中にも
           起きる（あとで戻る）。負けたかどうかは `status` が言う。
      */
      const status = toDisputeStatus(dispute.status);
      return {
        ...base,
        // ⚠️ 知らない状態は畳めない。推測で進めるより、無視して記録に残す。
        kind: status === null ? 'ignored' : 'disputed',
        orderId: readOrderId(dispute.metadata),
        sessionRef: null,
        paymentRef: typeof dispute.payment_intent === 'string' ? dispute.payment_intent : null,
        chargeRef: typeof dispute.charge === 'string' ? dispute.charge : null,
        amount: null,
        currency: dispute.currency,
        failureCode: null,
        disputeRef: dispute.id,
        disputeStatus: status,
        // ⚠️ **争われている額。** 注文の総額と一致するとは限らない。
        disputeAmount: dispute.amount,
        disputeReason: toSafeDisputeReason(dispute.reason),
      };
    }

    default:
      /*
        ⚠️ **知らないイベントは無視して 2xx を返す**（指示書 §5.4）。
           拒否すると Stripe が再送し続け、いずれ Webhook の宛先ごと
           無効化される。受け取ったことだけは記録する。
      */
      return {
        ...base,
        kind: 'ignored' satisfies PaymentFactKind,
        orderId: null,
        sessionRef: null,
        paymentRef: null,
        chargeRef: null,
        amount: null,
        currency: null,
        failureCode: null,
      };
  }
}

/**
 * こちらの返金理由を、Stripe が受け付ける語彙へ移す。
 *
 * ⚠️ **そのまま渡さない。** Stripe は 3 語しか受け付けず、こちらの符号とは
 * 別物。合わない語を送ると要求ごと弾かれ、返金が通らない。
 *
 * ⚠️ **`buyer_request` は指定しない（`null`）。** Stripe の
 * `requested_by_customer` は「不正利用の申告ではない」ことを示すために
 * 使われ、こちらの「誤購入」と意味が完全には重ならない。**分からない
 * ものを分かったことにしない**——省略すれば Stripe 側で `null` のまま残る。
 */
function stripeReason(reason: 'buyer_request' | 'our_fault' | 'provider_initiated'): string | null {
  // 当方の不具合は Stripe でも「重複・誤請求」に最も近い。
  return reason === 'our_fault' ? 'duplicate' : null;
}

function readOrderId(metadata: Stripe.Metadata | null | undefined): string | null {
  const value = metadata?.['order_id'];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * 例外を、外へ出してよい短い要約にする。
 *
 * ⚠️ **`error.message` を返さない。** Stripe の例外文には要求の内容が
 * 含まれることがある。返すのは種別までにする。
 */
function safeErrorSummary(error: unknown): string {
  if (error instanceof Stripe.errors.StripeError) {
    return `stripe error: ${error.type}`;
  }
  return 'stripe request failed';
}

/**
 * 新しい鍵で決済事業者へ問い合わせ、アカウント識別子を得る（`UD-118`）。
 *
 * ⚠️ **業務データを送らない。** アカウントを読むだけの呼び出しにする。
 * 試し打ちで本物の決済や顧客を作らない。
 *
 * ⚠️ **失敗の詳細を返さない。** 例外の本文には、送った鍵の一部や
 * 内部の URL が混ざりうる。呼び出し側へ渡すのは成否だけにする。
 *
 * ⚠️ **これが通って初めて「別のアカウントかどうか」が確定する。**
 * 二者承認をやめた（2026-08-19 決定）代わりの守りなので、
 * 有効化の前に必ず通す。
 */
export async function probeStripeAccount(
  secretKey: string,
  apiVersion: string | null,
): Promise<{ readonly ok: true; readonly accountRef: string } | { readonly ok: false }> {
  try {
    const client = new Stripe(secretKey, {
      ...(apiVersion === null ? {} : { apiVersion: apiVersion as Stripe.LatestApiVersion }),
    });
    /*
      ⚠️ **`retrieveCurrent()` を使う。** 「この鍵が属するアカウント」を
         読む呼び出し。`retrieve(id)` は別アカウントを読む口なので、
         こちらの用途には合わない（そもそも id が分からない）。
    */
    const account = await client.accounts.retrieveCurrent();
    return account.id === '' ? { ok: false } : { ok: true, accountRef: account.id };
  } catch {
    // ⚠️ 例外を握りつぶすのではなく、**外へ出さない**。理由は上のとおり。
    return { ok: false };
  }
}

/**
 * Stripe の争いの状態を、こちらの語彙へ畳む。
 *
 * ⚠️ **`warning_*` を争いと同じにしない。** カード会社が調べ始めただけで、
 * 申し立てにならずに消えることもある。同じ扱いにすると、消えた警告の
 * ぶんまで精算を止め、作家さまへのお支払いが理由なく遅れる。
 *
 * ⚠️ **知らない状態は `null` を返す。** 推測で進めるより、無視して
 * 記録に残すほうがよい。Stripe が語彙を増やしたときに、こちらが
 * 勝手に「決着した」と読むのがいちばん困る。
 */
function toDisputeStatus(raw: string): DisputeStatus | null {
  switch (raw) {
    case 'warning_needs_response':
    case 'warning_under_review':
    case 'warning_closed':
      return 'warning';
    case 'needs_response':
      return 'needs_response';
    case 'under_review':
      return 'under_review';
    case 'won':
      return 'won';
    case 'lost':
      return 'lost';
    default:
      return null;
  }
}
