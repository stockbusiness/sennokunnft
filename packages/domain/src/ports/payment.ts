import type { DomainError } from '../shared/errors';
import type { Result } from '../shared/result';
import type { ProviderPaymentFact } from '../payment/provider-event';

/**
 * 決済事業者との境界（決済 Phase P2・指示書 §5.1）。
 *
 * ⚠️ **事業者固有の型をこの向こうへ出さない。** SDK の型・Session そのもの・
 * イベントの本文全体・例外の文面は、すべて Adapter の中で止める。
 * 出すと、事業者を替えるときにドメインごと書き直しになる。
 *
 * ⚠️ **この境界は「お金を動かす」ことを知らない。** 支払いの口を作り、
 * 届いた知らせを翻訳するだけ。注文を進めてよいかの判断は
 * `decideCheckout` と `verifyPaymentFact` が持つ。
 */

export interface CreateCheckoutSessionInput {
  /** こちらの注文ID。事業者の metadata へ入れる。 */
  readonly orderId: string;
  readonly orderNumber: string;
  /** 表示する商品名。⚠️ 注文時点のスナップショットを渡す。 */
  readonly itemName: string;
  /** 最小通貨単位の整数。⚠️ ブラウザから来た値を渡さない。 */
  readonly amount: number;
  readonly currency: string;
  readonly quantity: number;
  /** この時刻で口を閉じる。⚠️ お取り置きの期限を超えない。 */
  readonly expiresAt: Date;
  /**
   * 事業者へ渡す冪等キー。
   *
   * ⚠️ **業務の冪等キーと別物。** こちらは「同じ API 呼び出しを 2 回
   * 送っても口が 1 つしかできない」ためのもの。注文IDと試行から
   * サーバー側で作る（指示書 §5.2）。
   */
  readonly idempotencyKey: string;
  /** 相関ID。⚠️ 個人情報を含めない。 */
  readonly correlationId: string | null;
}

export interface CheckoutSessionCreated {
  readonly sessionRef: string;
  readonly paymentRef: string | null;
  readonly url: string;
  readonly expiresAt: Date;
}

export interface PaymentGatewayPort {
  /**
   * 支払いの口を作る。
   *
   * ⚠️ **DB のトランザクションの中で呼ばない**（指示書 §4-10）。
   * 外部への往復は数秒かかることがあり、その間 作品行のロックを
   * 握り続けると、他の購入が全部待たされる。
   */
  createCheckoutSession(
    input: CreateCheckoutSessionInput,
  ): Promise<Result<CheckoutSessionCreated, DomainError>>;

  /**
   * 届いた知らせの署名を確かめ、業務の事象へ翻訳する。
   *
   * ⚠️ **署名を確かめる前の生のバイト列を渡すこと。** JSON にして
   * 組み直したものでは、空白や順序が変わって署名が合わなくなる。
   * 合わせるために署名検証を緩めると、誰でも「決済成功」を送れる。
   */
  verifyAndParseWebhook(
    rawBody: Buffer,
    signatureHeader: string,
  ): Result<ProviderPaymentFact, DomainError>;
}
