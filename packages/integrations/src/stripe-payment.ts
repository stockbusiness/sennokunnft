import Stripe from 'stripe';
import {
  domainError,
  err,
  ok,
  toSafeFailureCode,
  type CheckoutSessionCreated,
  type CreateCheckoutSessionInput,
  type DomainError,
  type PaymentFactKind,
  type PaymentGatewayPort,
  type ProviderPaymentFact,
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
