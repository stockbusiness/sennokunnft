import { describe, expect, it } from 'vitest';

import {
  CHECK_FRESHNESS_MS,
  enableIntegration,
  isSalesSetupComplete,
  requiredSecretPurposes,
  updatePaymentSettings,
  validateSecretKeyForEnvironment,
  validateWebhookSecret,
  ORDER_ID_PLACEHOLDER,
  PAYMENT_LIVE_KEY_PREFIX,
  PAYMENT_TEST_KEY_PREFIX,
  PAYMENT_WEBHOOK_SECRET_PREFIX,
  type IntegrationSettings,
  type PaymentSettingsFields,
} from '../src/index';

const NOW = new Date('2026-08-19T09:00:00.000Z');
const FRESH = new Date(NOW.getTime() - 60_000);

/*
  ⚠️ 鍵の値をテストへ直接書かない。接頭辞は本体から取り、残りは
     明らかに偽物と分かる文字列を繋ぐ。混入検査（check-secrets）に
     引っかからないようにするためでもある。
*/
const TEST_KEY = `${PAYMENT_TEST_KEY_PREFIX}NOT_A_REAL_KEY`;
const LIVE_KEY = `${PAYMENT_LIVE_KEY_PREFIX}NOT_A_REAL_KEY`;
const WEBHOOK_SECRET = `${PAYMENT_WEBHOOK_SECRET_PREFIX}NOT_A_REAL_SECRET`;

const COMPLETE_PAYMENT: PaymentSettingsFields = {
  apiVersion: '2026-07-29.dahlia',
  checkoutSuccessUrl: `https://example.com/orders/${ORDER_ID_PLACEHOLDER}`,
  checkoutCancelUrl: 'https://example.com/orders',
  platformFeeRateBps: 2000,
};

function paymentSettings(
  payment: Partial<PaymentSettingsFields> = {},
  overrides: Partial<IntegrationSettings> = {},
): IntegrationSettings {
  return {
    id: 'setting-payment',
    service: 'payment',
    environment: 'production',
    endpointUrl: 'https://api.stripe.com',
    keyId: null,
    apiVersion: null,
    timeoutMs: 10_000,
    maxAttempts: 5,
    enabled: false,
    payment: { ...COMPLETE_PAYMENT, ...payment },
    rowVersion: 1,
    ...overrides,
  };
}

describe('鍵と環境の突き合わせ', () => {
  it('production に本番鍵は通る', () => {
    expect(validateSecretKeyForEnvironment(LIVE_KEY, 'production').ok).toBe(true);
  });

  it('staging にテスト鍵は通る', () => {
    expect(validateSecretKeyForEnvironment(TEST_KEY, 'staging').ok).toBe(true);
  });

  /*
    production にテスト鍵は「決済は通るのに 1 円も入らない」。
    起動時だけでなく保存の時点で止める。
  */
  it('production にテスト鍵は保存させない', () => {
    const result = validateSecretKeyForEnvironment(TEST_KEY, 'production');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PAYMENT_SECRET_ENVIRONMENT_MISMATCH');
    }
  });

  /* staging に本番鍵は「試験のつもりで本物のお金が動く」。 */
  it('staging に本番鍵は保存させない', () => {
    const result = validateSecretKeyForEnvironment(LIVE_KEY, 'staging');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PAYMENT_SECRET_ENVIRONMENT_MISMATCH');
    }
  });

  it('そもそも秘密鍵の形でなければ断る', () => {
    const result = validateSecretKeyForEnvironment('pk_test_public', 'staging');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PAYMENT_SECRET_INVALID');
    }
  });

  /* 理由に鍵の値が混ざると、画面にもログにも出てしまう。 */
  it('断る理由に鍵の値を含めない', () => {
    const result = validateSecretKeyForEnvironment(LIVE_KEY, 'staging');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(JSON.stringify(result.error)).not.toContain('NOT_A_REAL_KEY');
    }
  });
});

describe('Webhook 署名鍵', () => {
  it('whsec_ で始まれば通る', () => {
    expect(validateWebhookSecret(WEBHOOK_SECRET).ok).toBe(true);
  });

  it('別の値を貼ったら断る', () => {
    expect(validateWebhookSecret(TEST_KEY).ok).toBe(false);
  });
});

describe('決済設定の書き換え', () => {
  it('https でない戻り先は断る', () => {
    const result = updatePaymentSettings(COMPLETE_PAYMENT, {
      checkoutSuccessUrl: `http://example.com/orders/${ORDER_ID_PLACEHOLDER}`,
    });
    expect(result.ok).toBe(false);
  });

  /*
    成功URLに注文の目印が無いと、画面はどの注文を出せばよいか決められない。
  */
  it('成功URLに注文の目印が無ければ断る', () => {
    const result = updatePaymentSettings(COMPLETE_PAYMENT, {
      checkoutSuccessUrl: 'https://example.com/thanks',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PAYMENT_SETTINGS_INVALID');
    }
  });

  it('キャンセルURLには目印を求めない', () => {
    const result = updatePaymentSettings(COMPLETE_PAYMENT, {
      checkoutCancelUrl: 'https://example.com/artworks',
    });
    expect(result.ok).toBe(true);
  });

  it('手数料率が範囲外なら断る', () => {
    expect(updatePaymentSettings(COMPLETE_PAYMENT, { platformFeeRateBps: 10_001 }).ok).toBe(false);
    expect(updatePaymentSettings(COMPLETE_PAYMENT, { platformFeeRateBps: -1 }).ok).toBe(false);
    expect(updatePaymentSettings(COMPLETE_PAYMENT, { platformFeeRateBps: 1.5 }).ok).toBe(false);
  });

  it('空文字は未設定へ寄せる（入れたつもりで空、を有効にしない）', () => {
    const result = updatePaymentSettings(COMPLETE_PAYMENT, { checkoutCancelUrl: '   ' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.checkoutCancelUrl).toBeNull();
    }
  });
});

describe('販売設定の完了判定', () => {
  /* 0 は「無料」ではなく「まだ決めていない」。 */
  it('手数料率 0 は未完了', () => {
    expect(isSalesSetupComplete({ ...COMPLETE_PAYMENT, platformFeeRateBps: 0 })).toBe(false);
  });

  it('手数料率が入っていれば完了', () => {
    expect(isSalesSetupComplete(COMPLETE_PAYMENT)).toBe(true);
  });
});

describe('決済の有効化', () => {
  const check = { succeeded: true, executedAt: FRESH };
  const base = {
    activeSecretPurposes: ['api_key', 'hmac_secret'] as const,
    lastCheck: check,
    freshnessMs: CHECK_FRESHNESS_MS,
    now: NOW,
  };

  it('そろっていれば有効にできる', () => {
    const result = enableIntegration({ ...base, settings: paymentSettings() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.enabled).toBe(true);
    }
  });

  /* 決済は鍵が 2 本要る。片方だけでは半端な状態になる。 */
  it('秘密鍵だけでは有効にできない', () => {
    const result = enableIntegration({
      ...base,
      settings: paymentSettings(),
      activeSecretPurposes: ['api_key'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INTEGRATION_SECRET_MISSING');
    }
  });

  it('署名鍵だけでは有効にできない', () => {
    const result = enableIntegration({
      ...base,
      settings: paymentSettings(),
      activeSecretPurposes: ['hmac_secret'],
    });
    expect(result.ok).toBe(false);
  });

  it('手数料率 0 のままでは有効にできない', () => {
    const result = enableIntegration({
      ...base,
      settings: paymentSettings({ platformFeeRateBps: 0 }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PAYMENT_SETTINGS_INVALID');
    }
  });

  it('戻り先が無ければ有効にできない', () => {
    const result = enableIntegration({
      ...base,
      settings: paymentSettings({ checkoutSuccessUrl: null }),
    });
    expect(result.ok).toBe(false);
  });

  it('接続テストの成功が無ければ有効にできない', () => {
    const result = enableIntegration({ ...base, settings: paymentSettings(), lastCheck: null });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INTEGRATION_CHECK_REQUIRED');
    }
  });

  /*
    決済には鍵の識別子という概念が無い。必須にすると、埋めるための
    嘘の値が入る。
  */
  it('鍵の識別子は求めない', () => {
    const result = enableIntegration({ ...base, settings: paymentSettings({}, { keyId: null }) });
    expect(result.ok).toBe(true);
  });
});

describe('要る資格情報', () => {
  it('決済は 2 種類', () => {
    expect(requiredSecretPurposes('payment')).toEqual(['api_key', 'hmac_secret']);
  });

  it('Wallet は署名鍵だけ', () => {
    expect(requiredSecretPurposes('ovew_wallet')).toEqual(['hmac_secret']);
  });

  /* 画面から変えられない連携には、有効化の条件も無い。 */
  it('管理外の連携には求めない', () => {
    expect(requiredSecretPurposes('storage')).toEqual([]);
    expect(requiredSecretPurposes('auth')).toEqual([]);
  });
});
