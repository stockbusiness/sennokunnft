import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  domainError,
  err,
  ok,
  DISPUTE_STATUSES,
  toSafeDisputeReason,
  toSafeFailureCode,
  type CheckoutSessionCreated,
  type CreateCheckoutSessionInput,
  type DisputeStatus,
  type DomainError,
  type PaymentGatewayPort,
  type PaymentFactKind,
  type ProviderPaymentFact,
  type RefundExecuted,
  type RefundPaymentInput,
  type Result,
} from '@sengoku/domain';

/** 署名の鮮度の許容幅。これを超える古い通知はリプレイとみなす。 */
export const WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * 開発・テスト用の擬似決済ゲートウェイ。
 *
 * ✅ 実決済サービスへ接続しない。Stripe の鍵を持たない人が、手元で
 * 購入の流れを最後まで通せるようにするためにある（指示書 §5.4 の
 * 「ローカルの非 Stripe 開発を阻害しない」）。
 *
 * 擬似実装ではあるが、**署名の作り方と検証の手順は Stripe と同じ**
 * （`t=<unix秒>,v1=<hex>`、`HMAC-SHA256("<t>.<生の本文>")`）。
 * ここを簡略化すると、本物へ差し替えたときに検証手順の欠落に気付けない。
 */
export class FakePaymentGateway implements PaymentGatewayPort {
  public readonly provider = 'fake';

  constructor(
    private readonly webhookSecret: string,
    private readonly checkoutBaseUrl = 'http://localhost:3000/fake-checkout',
    private readonly now: () => Date = () => new Date(),
  ) {
    if (webhookSecret.length === 0) {
      throw new Error('webhook secret must not be empty');
    }
  }

  createCheckoutSession(
    input: CreateCheckoutSessionInput,
  ): Promise<Result<CheckoutSessionCreated, DomainError>> {
    /*
      ⚠️ **冪等キーから口の識別子を導く。** 同じキーで 2 回呼ばれても
      同じものを返す。本物の Stripe も冪等キーで同じ挙動をするので、
      ここだけ毎回違う値を返すと、擬似のときだけ二重に口ができる。
    */
    const sessionRef = `fake_cs_${input.idempotencyKey}`;
    return Promise.resolve(
      ok({
        sessionRef,
        paymentRef: `fake_pi_${input.idempotencyKey}`,
        // ⚠️ 世代はアダプタが知らない。包む側が押す。`fake` では常に `null`。
        credentialId: null,
        url: `${this.checkoutBaseUrl}/${sessionRef}`,
        expiresAt: input.expiresAt,
      }),
    );
  }

  /**
   * 返金を投げる（`UD-120`）。
   *
   * ⚠️ **常に成功する擬似実装にしない。** 事業者側の識別子が無ければ
   * 断る。本物と同じところで落ちないと、手元では通るのに本番で
   * 落ちる経路ができる。
   *
   * ⚠️ **冪等キーから識別子を導く。** 同じ返金の行で 2 回投げても
   * 同じ識別子を返す。毎回違う値にすると、擬似のときだけ二重に
   * 記録される。
   */
  refundPayment(input: RefundPaymentInput): Promise<Result<RefundExecuted, DomainError>> {
    if (
      (input.paymentRef === null || input.paymentRef === '') &&
      (input.chargeRef === null || input.chargeRef === '')
    ) {
      return Promise.resolve(
        err(domainError('REFUND_PROVIDER_ERROR', 'no provider payment reference')),
      );
    }
    return Promise.resolve(
      ok({
        refundRef: `fake_re_${input.idempotencyKey}`,
        amount: input.amount,
        // 擬似では即時に返る。銀行振込の遅延は再現しない。
        pending: false,
      }),
    );
  }

  /**
   * 署名を検証して、業務の事象へ翻訳する。
   *
   * ⚠️ **検証を通るまで本文を解釈しない。** 検証前の本文は
   * 攻撃者が中身を決められるデータで、記録もしない。
   */
  async verifyAndParseWebhook(
    rawBody: Buffer,
    signatureHeader: string,
  ): Promise<Result<ProviderPaymentFact, DomainError>> {
    const parsed = parseSignatureHeader(signatureHeader);
    if (parsed === null) {
      return err(domainError('WEBHOOK_SIGNATURE_INVALID', 'signature header is malformed'));
    }

    // 1. 鮮度。署名が正しくても古い通知は受け付けない（リプレイ対策）。
    const ageMs = Math.abs(this.now().getTime() - parsed.timestamp * 1000);
    if (ageMs > WEBHOOK_TOLERANCE_MS) {
      return err(domainError('WEBHOOK_SIGNATURE_INVALID', 'signature is too old'));
    }

    // 2. 生の本文から署名を再計算する。組み直した JSON では一致しない。
    const expected = signWebhookPayload(this.webhookSecret, parsed.timestamp, rawBody);
    if (!safeCompare(expected, parsed.signature)) {
      return err(domainError('WEBHOOK_SIGNATURE_INVALID', 'signature does not match'));
    }

    // 3. 検証を通過してから、はじめて本文を解釈する。
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return err(domainError('WEBHOOK_SIGNATURE_INVALID', 'body is not valid json'));
    }

    const fact = toFact(payload, parsed.timestamp);
    if (fact === null) {
      return err(domainError('WEBHOOK_SIGNATURE_INVALID', 'body is not a known envelope'));
    }
    return ok(fact);
  }
}

interface FakeEnvelope {
  readonly id?: unknown;
  readonly type?: unknown;
  readonly livemode?: unknown;
  readonly api_version?: unknown;
  readonly data?: {
    readonly order_id?: unknown;
    readonly session_ref?: unknown;
    readonly payment_ref?: unknown;
    readonly charge_ref?: unknown;
    readonly amount?: unknown;
    readonly currency?: unknown;
    readonly failure_code?: unknown;
    readonly refund_ref?: unknown;
    /** ⚠️ 累計。今回ぶんではない（本物と同じ形にそろえてある）。 */
    readonly refunded_total?: unknown;
    readonly dispute_ref?: unknown;
    readonly dispute_status?: unknown;
    readonly dispute_amount?: unknown;
    readonly dispute_reason?: unknown;
  };
}

/** 擬似の本文を、業務の事象へ畳む。 */
function toFact(payload: unknown, timestampSec: number): ProviderPaymentFact | null {
  const envelope = payload as FakeEnvelope;
  if (typeof envelope.id !== 'string' || typeof envelope.type !== 'string') {
    return null;
  }
  const data = envelope.data ?? {};
  return {
    kind: toKind(envelope.type),
    eventId: envelope.id,
    eventType: envelope.type,
    apiVersion: typeof envelope.api_version === 'string' ? envelope.api_version : null,
    livemode: envelope.livemode === true,
    orderId: typeof data.order_id === 'string' ? data.order_id : null,
    sessionRef: typeof data.session_ref === 'string' ? data.session_ref : null,
    paymentRef: typeof data.payment_ref === 'string' ? data.payment_ref : null,
    chargeRef: typeof data.charge_ref === 'string' ? data.charge_ref : null,
    amount: typeof data.amount === 'number' ? data.amount : null,
    currency: typeof data.currency === 'string' ? data.currency : null,
    failureCode:
      typeof data.failure_code === 'string' ? toSafeFailureCode(data.failure_code) : null,
    refundRef: typeof data.refund_ref === 'string' ? data.refund_ref : null,
    refundedTotal: typeof data.refunded_total === 'number' ? data.refunded_total : null,
    disputeRef: typeof data.dispute_ref === 'string' ? data.dispute_ref : null,
    disputeStatus: toDisputeStatus(data.dispute_status),
    disputeAmount: typeof data.dispute_amount === 'number' ? data.dispute_amount : null,
    disputeReason:
      typeof data.dispute_reason === 'string' ? toSafeDisputeReason(data.dispute_reason) : null,
    occurredAt: new Date(timestampSec * 1000),
    // ⚠️ 世代はアダプタが知らない。包む側（`ResolvingPaymentGateway`）が押す。
    credentialId: null,
  };
}

/** 擬似のイベント名を、Stripe の Adapter と同じ 3 つの事象へ畳む。 */
function toKind(eventType: string): PaymentFactKind {
  if (eventType === 'payment.succeeded') return 'succeeded';
  if (eventType === 'payment.failed') return 'failed';
  if (eventType === 'checkout.expired') return 'checkout_expired';
  if (eventType === 'payment.refunded') return 'refunded';
  if (eventType === 'payment.disputed') return 'disputed';
  // ⚠️ 知らないものは無視する。拒否すると、相手が再送し続ける。
  return 'ignored';
}

/**
 * 擬似の争いの状態を畳む。
 *
 * ⚠️ **知らない値は `null`。** 本物と同じにする。ここを素通しにすると、
 * 「知らない状態を無視する」経路が試験から消える。
 */
function toDisputeStatus(raw: unknown): DisputeStatus | null {
  return typeof raw === 'string' && (DISPUTE_STATUSES as readonly string[]).includes(raw)
    ? (raw as DisputeStatus)
    : null;
}

/** `t=<unix秒>,v1=<hex>` 形式のヘッダを解釈する。 */
function parseSignatureHeader(header: string): { timestamp: number; signature: string } | null {
  const parts = header.split(',');
  let timestamp: number | undefined;
  let signature: string | undefined;

  for (const part of parts) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === 't' && /^\d+$/.test(value)) {
      timestamp = Number.parseInt(value, 10);
    } else if (key === 'v1') {
      signature = value;
    }
  }

  if (timestamp === undefined || signature === undefined) {
    return null;
  }
  return { timestamp, signature };
}

/** 署名を計算する。テストで正しい署名を作るためにも使う。 */
export function signWebhookPayload(secret: string, timestampSec: number, rawBody: Buffer): string {
  return createHmac('sha256', secret)
    .update(`${String(timestampSec)}.`)
    .update(rawBody)
    .digest('hex');
}

/** タイミング安全な比較。文字ごとの早期打ち切りで署名を推測されないようにする。 */
function safeCompare(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}
