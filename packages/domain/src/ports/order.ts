import type { DomainError } from '../shared/errors';
import type { Result } from '../shared/result';
import type {
  FulfillmentStatus,
  OrderPaymentStatus,
  OrderStatus,
  RefundStatus,
} from '../order/order-status';
import type { ReservationStatus } from '../order/reservation';
import type { OrderAmounts } from '../order/pricing';
import type { OrderSearchCriteria } from '../order/search';
import type { OrderNoteEntry } from '../order/timeline';

/**
 * 注文の永続化境界（決済 Phase P0・P1）。
 *
 * ⚠️ **在庫の排他はここでしか成立しない。** ドメインの `createOrder` は
 * 「その瞬間のカウンタで通るか」しか見られない。読み取りと書き込みの
 * あいだに割り込みが入るため、**作品行のロックと DB の CHECK 制約**が
 * 最後の砦になる。実装は必ず同一トランザクションで
 * 「ロック → 冪等キー確認 → 在庫再判定 → 注文・明細・予約の作成 →
 * 作品カウンタの更新」を行うこと。
 *
 * ⚠️ **決済事業者を知らない。** Stripe の語彙をこの境界へ持ち込まない。
 */

/** 保存する注文明細。⚠️ すべて注文時点のスナップショット。 */
export interface OrderItemCommand {
  readonly id: string;
  readonly listingId: string;
  readonly artworkId: string;
  readonly creatorAccountId: string;
  readonly titleSnapshot: string;
  /** 注文時点の作家さまの表示名。⚠️ マスタを引き直さない。 */
  readonly creatorNameSnapshot: string | null;
  readonly unitPriceAmount: number;
  readonly unitPriceCurrency: string;
  readonly quantity: number;
  readonly totalAmount: number;
}

/**
 * 注文を 1 件作るための、確定済みの値。
 *
 * ⚠️ **ここに「価格を引く」余地を残さない。** 値はすべて呼び出し側が
 * DB と設定から決めたうえで渡す。実装が listing を読み直して価格を
 * 埋めると、注文時点のスナップショットという原則が崩れる。
 */
export interface CreateOrderCommand {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly accountId: string;
  readonly commonUserId: string | null;
  readonly creatorAccountId: string;
  readonly idempotencyKey: string;
  readonly currency: string;
  readonly amounts: OrderAmounts;
  readonly orderStatus: OrderStatus;
  readonly paymentStatus: OrderPaymentStatus;
  readonly fulfillmentStatus: FulfillmentStatus;
  readonly refundStatus: RefundStatus;
  readonly item: OrderItemCommand;
  readonly reservationId: string;
  readonly reservationExpiresAt: Date;
  /** 要求数量。⚠️ 実装はロック後のカウンタで**もう一度**在庫を判定する。 */
  readonly quantity: number;
  /**
   * 注文時点で施行されていた利用規約の版（`UD-126`）。
   *
   * ⚠️ **同意の記録ではない。** 「何が表示されていたか」の記録で、
   * 価格・手数料率と同じスナップショット原則。あとから規約を改定しても
   * 過去の注文は動かない。
   * ⚠️ 規約が未公開なら `null`。**無いことを、無いまま残す。**
   */
  readonly termsVersionId: string | null;
  readonly termsVersion: number | null;
  readonly now: Date;
}

/** 画面と API が読む注文。⚠️ 個人を特定する値はここに載せない。 */
export interface OrderView {
  readonly id: string;
  readonly orderNumber: string;
  readonly accountId: string;
  readonly creatorAccountId: string;
  readonly status: OrderStatus;
  readonly paymentStatus: OrderPaymentStatus;
  readonly fulfillmentStatus: FulfillmentStatus;
  readonly refundStatus: RefundStatus;
  readonly currency: string;
  readonly subtotalAmount: number;
  readonly discountAmount: number;
  readonly totalAmount: number;
  readonly platformFeeRateBps: number;
  readonly platformFeeAmount: number;
  readonly creatorAmount: number;
  readonly reservationExpiresAt: Date | null;
  readonly paidAt: Date | null;
  /**
   * 冪等キーの識別表示（指示書 §9.2）。
   *
   * ⚠️ **全体を持ち出さない。** 問い合わせの突き合わせに要るのは先頭の
   * 数文字で、全体を画面へ出しても運用の役に立たないまま、
   * 控えられる面だけが増える。切り詰めは実装側（DB 境界）で行う。
   */
  readonly idempotencyKeyPrefix: string;
  readonly createdAt: Date;
  readonly item: OrderItemView | null;
  readonly reservation: ReservationView | null;
  /** 決済行が付いているか。⚠️ 事業者側の識別子そのものは返さない。 */
  readonly hasPayment: boolean;
  /** 受取権が発行されているか。 */
  readonly entitlementCount: number;
}

export interface OrderItemView {
  readonly id: string;
  readonly listingId: string;
  readonly artworkId: string;
  readonly creatorAccountId: string;
  readonly titleSnapshot: string;
  /** 注文時点の作家さまの表示名。⚠️ マスタを引き直さない。 */
  readonly creatorNameSnapshot: string | null;
  readonly unitPriceAmount: number;
  readonly unitPriceCurrency: string;
  readonly quantity: number;
  readonly totalAmount: number;
}

export interface ReservationView {
  readonly id: string;
  readonly status: ReservationStatus;
  readonly quantity: number;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly releasedAt: Date | null;
}

/**
 * 冪等キーで引き当てた結果。
 *
 * ⚠️ **`conflict` を「同じ注文」に丸めない。** 同じキーで別の商品が
 * 来たときに前の注文を返すと、利用者は買ったつもりのない物を
 * 買わされる。指示書 §4.5 が 409 を求めているのはそのため。
 */
export type CreateOrderOutcome =
  | { readonly kind: 'created'; readonly order: OrderView }
  | { readonly kind: 'reused'; readonly order: OrderView }
  | { readonly kind: 'conflict' };

/** 期限切れの掃き出しで 1 件ぶん解放した結果。 */
export interface ReleasedReservation {
  readonly reservationId: string;
  readonly orderId: string;
  readonly artworkId: string;
  readonly quantity: number;
}

export interface OrderListQuery {
  readonly limit: number;
  readonly cursor?: string | undefined;
  readonly accountId?: string | undefined;
  /**
   * 絞り込みの条件（`UD-121`）。
   *
   * ⚠️ **ここへ平文のメールアドレスを持ち込まない**（`UD-503`）。
   * 変換は API の入口で 1 回だけ行い、以降は照合値だけを運ぶ。
   */
  readonly criteria?: OrderSearchCriteria | undefined;
}

export interface OrderListPage {
  readonly items: readonly OrderView[];
  readonly nextCursor: string | null;
}

export interface OrderRepository {
  /**
   * 注文・明細・仮引当を 1 トランザクションで作る。
   *
   * 実装の責務:
   * 1. 作品行を `FOR UPDATE` でロックする
   * 2. `accountId + idempotencyKey` で既存注文を探す
   *    （同じ商品なら `reused`、違う商品なら `conflict`）
   * 3. ロック後のカウンタで在庫を**再判定**する
   * 4. 注文・明細・仮引当を作り、作品の `reservedCount` を増やす
   *
   * ⚠️ 一意制約違反や CHECK 制約違反を握りつぶさない。
   * 握りつぶすと「作れなかったのに成功した」応答が返る。
   */
  createWithReservation(
    command: CreateOrderCommand,
  ): Promise<Result<CreateOrderOutcome, DomainError>>;

  findById(orderId: string): Promise<OrderView | null>;

  /** 一覧（運営用）。新しい順。 */
  list(query: OrderListQuery): Promise<OrderListPage>;

  /**
   * 期限切れの仮引当を解放し、注文を `expired` にする。
   *
   * ⚠️ **再実行で二重に解放しない。** 実装は
   * `WHERE status = 'reserved' AND expires_at <= now` の条件付き更新で
   * 1 件ずつ確保（claim）してから在庫を戻すこと。件数を数えてから
   * まとめて戻すと、同時に走った 2 本が同じ行を 2 回戻す。
   *
   * @param limit 1 回で扱う上限。バッチ実行できるようにするため。
   */
  releaseExpiredReservations(now: Date, limit: number): Promise<readonly ReleasedReservation[]>;
}

// ---------------------------------------------------------------------------
// 決済（決済 Phase P2）
// ---------------------------------------------------------------------------

/**
 * 決済の試行がとりうる状態。
 *
 * ⚠️ **`not_started` は含めない。** 試行の行は支払い口を作ったときに
 * 初めてできるので、「まだ始めていない」状態の行は存在しない。
 * 注文側の `payment_status` には `not_started` があるが、それは
 * 「試行が 1 つも無い」ことを表しており、別の話。
 */
export type PaymentAttemptStatus = Exclude<OrderPaymentStatus, 'not_started'>;

/** 決済の試行 1 回ぶん。⚠️ 失敗した行も消さない。 */
export interface PaymentAttemptView {
  readonly id: string;
  readonly provider: string;
  readonly status: PaymentAttemptStatus;
  readonly sessionRef: string | null;
  readonly paymentRef: string | null;
  readonly chargeRef: string | null;
  readonly url: string | null;
  readonly amount: number;
  readonly currency: string;
  readonly expiresAt: Date | null;
  readonly paidAt: Date | null;
  readonly failureCode: string | null;
  readonly createdAt: Date;
}

/** 支払い口を記録するときの値。 */
export interface RecordCheckoutSessionCommand {
  readonly paymentId: string;
  readonly orderId: string;
  readonly provider: string;
  /**
   * どの世代の鍵で作ったか（`UD-118` / `UD-128`）。
   *
   * ⚠️ **これが無いと返金できない。** `sessionRef` / `paymentRef` は
   * 発行したアカウントに紐づくので、別の鍵では解決できない。
   */
  readonly credentialId: string | null;
  readonly sessionRef: string;
  readonly paymentRef: string | null;
  readonly url: string;
  readonly amount: number;
  readonly currency: string;
  readonly idempotencyKey: string;
  readonly expiresAt: Date;
  readonly now: Date;
}

/** 決済成功を確定するときの値。 */
export interface ConfirmPaymentCommand {
  readonly orderId: string;
  /**
   * 返金を受け付ける期限（`UD-104`）。
   *
   * ⚠️ **ここで確定して焼き付ける。** 判定のたびに「決済日 + 設定値」を
   * 計算しない。計算すると、14 日 → 30 日に変えた瞬間、精算済みの注文が
   * 「まだ返金できる」に化ける。
   *
   * ⚠️ 設定が未設定の配備では `null`。そのときは購入者都合の返金が
   * 通らなくなる——**期限を勝手に決めるより良い**。
   */
  readonly refundableUntil: Date | null;
  readonly provider: string;
  readonly eventId: string;
  readonly sessionRef: string | null;
  readonly paymentRef: string | null;
  readonly chargeRef: string | null;
  readonly amount: number;
  readonly currency: string;
  readonly paidAt: Date;
  /** 次の工程へ渡す出来事のID。⚠️ 1 件だけ作る。 */
  readonly outboxEventId: string;
  readonly now: Date;
}

/** Webhook を受け取ったときの記録。 */
export interface RecordWebhookCommand {
  readonly id: string;
  readonly provider: string;
  /** どの世代の鍵で署名を検証できたか（`UD-128`）。 */
  readonly credentialId: string | null;
  readonly eventId: string;
  readonly eventType: string;
  readonly apiVersion: string | null;
  readonly livemode: boolean;
  /** ⚠️ 本文の全体ではなく、digest だけ。 */
  readonly payloadDigest: string;
  readonly orderId: string | null;
  readonly now: Date;
}

/** 運営が追跡するための受信記録。⚠️ 本文は含まない。 */
export interface WebhookReceiptRecord {
  readonly eventType: string;
  readonly status: 'received' | 'processed' | 'ignored' | 'failed';
  readonly livemode: boolean | null;
  readonly apiVersion: string | null;
  readonly attemptCount: number;
  readonly receivedAt: Date;
  readonly processedAt: Date | null;
  readonly lastErrorCode: string | null;
}

/** 受け取った知らせを処理してよいか。 */
export type WebhookClaim =
  | { readonly kind: 'claimed' }
  /** すでに処理済み。⚠️ 成功として返す（相手に再送させない）。 */
  | { readonly kind: 'duplicate' };

export interface PaymentRepository {
  /**
   * その世代で処理した決済の件数（`UD-118`）。
   *
   * ⚠️ **件数だけ。** 金額を返さない。画面に要るのは「まだ使われているか」
   * の判断材料までで、売上はここから読むものではない。
   */
  countByCredential(credentialId: string): Promise<number>;

  /**
   * 受け取った知らせを記録し、処理してよいかを返す。
   *
   * ⚠️ **`(provider, event_id)` の UNIQUE で決める。** 「探して無ければ書く」
   * にすると、同時に届いた同じ知らせを 2 本とも処理してしまう。
   */
  claimWebhookEvent(command: RecordWebhookCommand): Promise<WebhookClaim>;

  /** 処理の結果を記録する。⚠️ 本文も事業者の符号もそのまま入れない。 */
  markWebhookProcessed(input: {
    readonly provider: string;
    readonly eventId: string;
    readonly status: 'processed' | 'ignored' | 'failed';
    readonly orderId: string | null;
    readonly paymentId: string | null;
    readonly errorCode: string | null;
    readonly now: Date;
  }): Promise<void>;

  /** その注文の試行を新しい順に返す。 */
  listAttempts(orderId: string): Promise<readonly PaymentAttemptView[]>;

  /**
   * その注文について受け取った知らせを新しい順に返す（運営の追跡用）。
   *
   * ⚠️ **本文は返さない。** 残しているのは digest だけで、そもそも
   * 返せるものが無い（指示書 §13「Webhook Payload 全文表示」は禁止）。
   */
  listWebhookReceipts(orderId: string): Promise<readonly WebhookReceiptRecord[]>;

  /**
   * その事業者から最後に知らせが届いた時刻。無ければ `null`。
   *
   * ⚠️ **注文に紐づかないものも数える。** 宛先の設定が誤っていると、
   * こちらの注文に一致しない知らせだけが届く。それでも「届いてはいる」
   * ことは、設定を直す人にとって重要な手掛かりになる。
   *
   * ⚠️ **本文も署名も返さない。** 返すのは時刻だけ。
   */
  findLastWebhookReceivedAt(provider: string): Promise<Date | null>;

  /** 支払い口を記録する。⚠️ 同じ冪等キーなら既存を返す。 */
  recordCheckoutSession(command: RecordCheckoutSessionCommand): Promise<PaymentAttemptView>;

  /**
   * 決済の成功を、1 トランザクションで確定する（指示書 §7）。
   *
   * 実装の責務:
   * 1. 決済行を `succeeded` にし、`paid_at` と参照IDを保存
   * 2. 注文を `paid` にし、`paid_at` を保存
   * 3. 仮引当を `consumed` にする
   * 4. `payment.succeeded` の Outbox を **1 件だけ** 作る
   *
   * ⚠️ **在庫のカウンタは動かさない**（決済 Phase P2 の決定 A）。
   * `reservedCount` を減らすのも `issuedCount` を増やすのも、
   * 受取権を作るのと同じトランザクションの中でだけ行う（Phase P3）。
   * ここで減らすと、受取権を作る前のわずかな間に販売枠が復活する。
   *
   * ⚠️ **再送で二重に確定しない。** 条件付き更新（`WHERE status = …`）で
   * 進め、すでに進んでいたら何もせず `false` を返すこと。
   */
  confirmPayment(command: ConfirmPaymentCommand): Promise<boolean>;

  /** 決済の失敗を記録する。⚠️ 注文は `checkout_created` のまま。 */
  recordFailure(input: {
    readonly orderId: string;
    readonly sessionRef: string | null;
    readonly paymentRef: string | null;
    readonly failureCode: string;
    readonly now: Date;
  }): Promise<void>;

  /**
   * 支払い口の期限切れを記録し、注文と仮引当を閉じる。
   *
   * ⚠️ **既存の解放ジョブと二重に解放しない**（指示書 §8）。
   * 条件付き更新で仮引当を掴んでから在庫を戻すこと。
   */
  expireCheckout(input: {
    readonly orderId: string;
    readonly sessionRef: string | null;
    readonly now: Date;
  }): Promise<boolean>;
}

/**
 * 対応メモの保管（`UD-121`）。
 *
 * ⚠️ **書き換えと削除の口を作らない。** 用意した瞬間に「間違えたから
 * 消しておいて」が始まり、揉めたときに参照できる記録が残らなくなる。
 * 訂正は新しいメモで行う。
 */
export interface OrderNoteRepository {
  /** その注文のメモを**古い順**に返す。経過へそのまま差し込むため。 */
  listByOrder(orderId: string): Promise<readonly OrderNoteEntry[]>;

  /**
   * メモを 1 件足す。
   *
   * ⚠️ 実装は本文をログへ出さないこと。運営の自由文で、
   * 何が書かれているかを前提にできない。
   */
  append(input: {
    readonly id: string;
    readonly orderId: string;
    readonly authorAccountId: string;
    readonly body: string;
    readonly now: Date;
  }): Promise<OrderNoteEntry>;
}
