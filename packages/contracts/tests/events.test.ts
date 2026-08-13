import { describe, expect, it } from 'vitest';
import {
  EVENT_NAMES,
  EVENT_DATA_SCHEMAS,
  entitlementIssuedDataSchema,
  eventEnvelopeSchema,
  livenessResponseSchema,
  orderPaidDataSchema,
  readinessResponseSchema,
} from '../src/index';

const VALID_ENVELOPE = {
  eventId: '01J8Z7Q4XXXXXXXXXXXXXXXXXX',
  eventName: 'order.paid',
  eventVersion: 1,
  occurredAt: '2026-01-01T00:00:00.000Z',
  aggregate: { type: 'order', id: 'order-1' },
  data: {},
};

describe('イベント封筒', () => {
  it('妥当な封筒を受け付ける', () => {
    expect(eventEnvelopeSchema.safeParse(VALID_ENVELOPE).success).toBe(true);
  });

  it('未知のイベント名を拒否する', () => {
    const result = eventEnvelopeSchema.safeParse({ ...VALID_ENVELOPE, eventName: 'order.unknown' });
    expect(result.success).toBe(false);
  });

  it('eventId がない封筒を拒否する（重複排除ができなくなるため）', () => {
    const { eventId: _eventId, ...withoutId } = VALID_ENVELOPE;
    expect(eventEnvelopeSchema.safeParse(withoutId).success).toBe(false);
  });

  it('occurredAt が ISO 8601 でなければ拒否する', () => {
    expect(
      eventEnvelopeSchema.safeParse({ ...VALID_ENVELOPE, occurredAt: '2026-01-01' }).success,
    ).toBe(false);
  });

  it('データ部スキーマが定義されているイベントは EVENT_NAMES に含まれる', () => {
    for (const name of Object.keys(EVENT_DATA_SCHEMAS)) {
      expect(EVENT_NAMES).toContain(name);
    }
  });
});

describe('order.paid のデータ部（個人情報を含めない）', () => {
  const valid = {
    orderId: 'order-1',
    accountId: 'account-1',
    total: { amount: 12000, currency: 'JPY' },
    paidAt: '2026-01-01T00:00:00.000Z',
    lines: [{ artworkId: 'artwork-1', quantity: 1, unitPrice: { amount: 12000, currency: 'JPY' } }],
  };

  it('妥当なデータを受け付ける', () => {
    expect(orderPaidDataSchema.safeParse(valid).success).toBe(true);
  });

  it('個人情報のフィールドは契約に存在しない', () => {
    const parsed = orderPaidDataSchema.parse({
      ...valid,
      // 誤って混入させた個人情報は、スキーマ通過後に残らないこと。
      email: 'buyer@example.com',
      phone: '090-0000-0000',
    });
    expect(parsed).not.toHaveProperty('email');
    expect(parsed).not.toHaveProperty('phone');
  });

  it('小数の金額を拒否する', () => {
    const result = orderPaidDataSchema.safeParse({
      ...valid,
      total: { amount: 120.5, currency: 'JPY' },
    });
    expect(result.success).toBe(false);
  });
});

describe('entitlement.issued のデータ部（Claim トークンを載せない）', () => {
  const valid = {
    entitlementId: 'entitlement-1',
    orderId: 'order-1',
    accountId: 'account-1',
    artworkId: 'artwork-1',
    serialNo: 7,
    expiresAt: null,
  };

  it('妥当なデータを受け付ける', () => {
    expect(entitlementIssuedDataSchema.safeParse(valid).success).toBe(true);
  });

  it('Claim トークンを渡してもスキーマ通過後に残らない', () => {
    // イベントは複数の購読者・ログ・キューを経由するため、秘密を載せてはならない。
    const parsed = entitlementIssuedDataSchema.parse({ ...valid, claimToken: 'secret-token' });
    expect(parsed).not.toHaveProperty('claimToken');
    expect(JSON.stringify(parsed)).not.toContain('secret-token');
  });

  it('シリアル番号は 1 以上の整数', () => {
    expect(entitlementIssuedDataSchema.safeParse({ ...valid, serialNo: 0 }).success).toBe(false);
    expect(entitlementIssuedDataSchema.safeParse({ ...valid, serialNo: 1.5 }).success).toBe(false);
  });
});

describe('ヘルスチェックの契約', () => {
  it('liveness の応答形式', () => {
    const result = livenessResponseSchema.safeParse({
      status: 'ok',
      service: 'api',
      version: '0.1.0',
      uptimeSec: 12,
    });
    expect(result.success).toBe(true);
  });

  it('readiness は劣化状態を表現できる', () => {
    const result = readinessResponseSchema.safeParse({
      status: 'degraded',
      service: 'api',
      checks: [{ name: 'database', status: 'fail', durationMs: 5001 }],
    });
    expect(result.success).toBe(true);
  });

  it('readiness の check に接続先を書く欄がない', () => {
    const parsed = readinessResponseSchema.parse({
      status: 'ok',
      service: 'api',
      checks: [
        { name: 'database', status: 'pass', durationMs: 3, host: 'db.internal.example.com' },
      ],
    });
    expect(JSON.stringify(parsed)).not.toContain('db.internal.example.com');
  });
});
