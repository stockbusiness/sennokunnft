import type { DomainError } from '../shared/errors';
import type { Result } from '../shared/result';
import type { ProviderPaymentFact } from '../payment/provider-event';
import type { RefundReason } from '../order/refund';

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
  /**
   * どの世代の鍵で作った口か（`UD-118` / `UD-128`）。
   *
   * ⚠️ **必ず注文の決済行へ残す。** ここで作った識別子
   * （`sessionRef` / `paymentRef`）は**発行したアカウントに紐づく**。
   * 別のアカウントの鍵では解決できないので、あとで返金するときに
   * 「どの鍵で作ったか」が分からないと**返金できない**。
   *
   * ⚠️ 緊急上書き中（配備環境の鍵を直接使う）や `fake` では `null`。
   */
  readonly credentialId: string | null;
}

/**
 * 返金を投げるときの値（`UD-120`）。
 *
 * ⚠️ **注文IDではなく、事業者側の決済識別子で指す。** 事業者はこちらの
 * 注文を知らない。metadata から引き直そうとすると、metadata を消した／
 * 付け忘れた決済が返金できなくなる。
 */
export interface RefundPaymentInput {
  /**
   * どの世代の鍵で決済したか（`UD-118` / `UD-128`）。
   *
   * ⚠️ **受付中の世代ではない。** 決済した当時の世代で開く。
   * 運営会社が変わったあと、新しいアカウントの鍵で旧アカウントの
   * 決済を返金することはできない。
   *
   * ⚠️ `null` は緊急上書き中か `fake` で作られた決済。そのときは
   * いま解決できる設定で投げる。
   */
  readonly credentialId: string | null;
  readonly paymentRef: string | null;
  readonly chargeRef: string | null;
  /** 返す額。最小通貨単位の整数。⚠️ 画面から来た値をそのまま渡さない。 */
  readonly amount: number;
  readonly currency: string;
  readonly reason: RefundReason;
  /**
   * 事業者へ渡す冪等キー。
   *
   * ⚠️ **返金の記録の識別子から作る。** 同じ行で 2 回投げても
   * 事業者側で 1 回になる。時刻や乱数から作ると、再試行のたびに
   * 別の返金になり、二重返金になる。
   */
  readonly idempotencyKey: string;
}

export interface RefundExecuted {
  /** 事業者が採番した返金の識別子。⚠️ 追随のときの突き合わせに使う。 */
  readonly refundRef: string;
  /** 事業者が実際に返した額。⚠️ 要求額と違うことがある。 */
  readonly amount: number;
  /**
   * 事業者側でまだ処理中か。
   *
   * ⚠️ **`true` を「成功」に丸めない。** 銀行振込の返金は日をまたぐ。
   * 丸めると、返っていないのに返した扱いの注文ができる。
   */
  readonly pending: boolean;
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
   *
   * ⚠️ **非同期なのは、署名鍵を毎回引き直すため。** 管理画面から鍵を
   * 差し替えたら次の通知から効いてほしい。起動時に読んだ値を持ち回ると、
   * 「差し替えたのに古い鍵で検証し続ける」という、気づきにくい形で壊れる。
   */
  verifyAndParseWebhook(
    rawBody: Buffer,
    signatureHeader: string,
  ): Promise<Result<ProviderPaymentFact, DomainError>>;

  /**
   * 返金を投げる（`UD-120`）。
   *
   * ⚠️ **決済した当時の世代の鍵で投げる**（`UD-118` §2）。受付中の世代で
   * 投げると、運営会社の切り替え後に「そんな決済は無い」と断られる。
   *
   * ⚠️ **DB のトランザクションの中で呼ばない。** 外部への往復は数秒
   * かかることがある。注文行を握ったまま待つと、他の操作が全部止まる。
   *
   * ⚠️ **例外を投げない。** 失敗は `Result` で返し、事業者の応答本文は
   * ここで捨てる。返金の要求には金額が載るので、例外文がそのまま
   * 応答やログへ出ると、そこに金額が漏れる。
   */
  refundPayment(input: RefundPaymentInput): Promise<Result<RefundExecuted, DomainError>>;
}
