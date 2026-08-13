import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  CheckoutSession,
  CheckoutSessionRequest,
  PaymentGatewayPort,
  VerifiedWebhook,
  WebhookVerificationInput,
} from '@sengoku/domain';

/** 署名の鮮度の許容幅。これを超える古い通知はリプレイとみなす。 */
export const WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * 開発・テスト用の擬似決済ゲートウェイ。
 *
 * ✅ 実決済サービスへ接続しない。決済事業者は未決定（UD-702）。
 *
 * 擬似実装ではあるが、**署名検証の手順は本物と同じ**にしてある。
 * ここを簡略化すると、実装を差し替えたときに検証手順の欠落に気付けない。
 */
export class FakePaymentGateway implements PaymentGatewayPort {
  public readonly provider = 'fake';

  constructor(
    private readonly webhookSecret: string,
    private readonly checkoutBaseUrl = 'http://localhost:3000/fake-checkout',
  ) {
    if (webhookSecret.length === 0) {
      throw new Error('webhook secret must not be empty');
    }
  }

  createCheckoutSession(request: CheckoutSessionRequest): Promise<CheckoutSession> {
    const providerSessionRef = `fake-session-${request.orderId}`;
    return Promise.resolve({
      providerSessionRef,
      redirectUrl: `${this.checkoutBaseUrl}/${providerSessionRef}`,
    });
  }

  /**
   * Webhook の署名を検証する。
   *
   * 失敗時は例外ではなく `null` を返す。呼び出し側は 400 を返し、
   * **本文を解釈も記録もしない**（検証前の本文は攻撃者が制御できるデータ）。
   */
  verifyWebhook(input: WebhookVerificationInput): VerifiedWebhook | null {
    const header = input.signatureHeader;
    if (header === undefined) {
      return null;
    }

    const parsed = parseSignatureHeader(header);
    if (parsed === null) {
      return null;
    }

    // 1. 鮮度の確認（リプレイ攻撃対策）。署名が正しくても古い通知は受け付けない。
    const ageMs = Math.abs(input.receivedAt.getTime() - parsed.timestamp * 1000);
    if (ageMs > WEBHOOK_TOLERANCE_MS) {
      return null;
    }

    // 2. 生の本文から署名を再計算する。パース後の再シリアライズでは一致しない。
    const expected = signWebhookPayload(this.webhookSecret, parsed.timestamp, input.rawBody);
    if (!safeCompare(expected, parsed.signature)) {
      return null;
    }

    // 3. 検証を通過してから、はじめて本文を解釈する。
    let payload: unknown;
    try {
      payload = JSON.parse(input.rawBody.toString('utf8'));
    } catch {
      return null;
    }

    const envelope = payload as { id?: unknown; type?: unknown };
    if (typeof envelope.id !== 'string' || typeof envelope.type !== 'string') {
      return null;
    }

    return { eventId: envelope.id, eventType: envelope.type, payload };
  }
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
