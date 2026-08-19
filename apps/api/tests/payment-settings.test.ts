import { describe, expect, it } from 'vitest';

import { STRIPE_LIVE_KEY_PREFIX, STRIPE_TEST_KEY_PREFIX } from '@sengoku/config';
import {
  PAYMENT_LIVE_KEY_PREFIX,
  PAYMENT_TEST_KEY_PREFIX,
  PAYMENT_API_ENDPOINT,
  isSalesSetupComplete,
  type IntegrationEnvironment,
  type IntegrationRepository,
  type IntegrationSettings,
  type PaymentSettingsFields,
} from '@sengoku/domain';
import { createPaymentConfigResolver, ResolvingPaymentGateway } from '@sengoku/integrations';

/*
  ⚠️ **同じ規則が 2 か所にある。**
     `@sengoku/config` は起動時の検査、`@sengoku/domain` は保存時の検査。
     config は依存を持てない決まりなので互いを参照できない。
     ずれると片方だけ素通りするため、ここで縛る。
     どちらの package にも置けないので、両方に依存できる api のテストに置く。
*/
describe('鍵の接頭辞が 2 か所でずれていないこと', () => {
  it('テスト鍵', () => {
    expect(PAYMENT_TEST_KEY_PREFIX).toBe(STRIPE_TEST_KEY_PREFIX);
  });

  it('本番鍵', () => {
    expect(PAYMENT_LIVE_KEY_PREFIX).toBe(STRIPE_LIVE_KEY_PREFIX);
  });
});

const COMPLETE: PaymentSettingsFields = {
  apiVersion: '2026-07-29.dahlia',
  checkoutSuccessUrl: 'https://example.com/orders/{ORDER_ID}',
  checkoutCancelUrl: 'https://example.com/orders',
  platformFeeRateBps: 2000,
};

const ENV_FALLBACK = {
  secretKey: `${PAYMENT_TEST_KEY_PREFIX}FROM_ENVIRONMENT`,
  webhookSecret: 'whsec_FROM_ENVIRONMENT',
  apiVersion: '2026-07-29.dahlia',
  successUrlTemplate: 'https://env.example.com/orders/{ORDER_ID}',
  cancelUrlTemplate: 'https://env.example.com/orders',
  platformFeeRateBps: 1000,
};

const DB_SECRET_KEY = `${PAYMENT_TEST_KEY_PREFIX}FROM_DATABASE`;
const DB_WEBHOOK_SECRET = 'whsec_FROM_DATABASE';

/** 設定と鍵だけを持つ、最小限の保管庫。 */
function repositoryDouble(options: {
  readonly settings: IntegrationSettings | null;
  readonly secrets?: Partial<Record<'api_key' | 'hmac_secret', string>>;
}): IntegrationRepository {
  const secrets = options.secrets ?? {};
  return {
    findSettings: async () => options.settings,
    revealForAdapter: async (
      _service: string,
      _environment: IntegrationEnvironment,
      purpose: 'api_key' | 'hmac_secret',
    ) => secrets[purpose] ?? null,
  } as unknown as IntegrationRepository;
}

function settings(overrides: Partial<IntegrationSettings> = {}): IntegrationSettings {
  return {
    id: 'setting-payment',
    service: 'payment',
    environment: 'staging',
    endpointUrl: PAYMENT_API_ENDPOINT,
    keyId: null,
    apiVersion: null,
    timeoutMs: 10_000,
    maxAttempts: 5,
    enabled: true,
    payment: COMPLETE,
    rowVersion: 1,
    ...overrides,
  };
}

describe('決済設定の解決', () => {
  /*
    管理画面で何も保存していない間は、配備時の設定で動き続ける。
    ここが崩れると、この変更を入れた瞬間に既存の配備が決済できなくなる。
  */
  it('DB に鍵が無ければ環境変数を使う', async () => {
    const resolve = createPaymentConfigResolver({
      integrations: repositoryDouble({ settings: null }),
      appEnvironment: 'staging',
      fallback: ENV_FALLBACK,
    });
    const result = await resolve();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.source).toBe('environment');
      expect(result.config.secretKey).toBe(ENV_FALLBACK.secretKey);
      expect(result.config.platformFeeRateBps).toBe(1000);
    }
  });

  /* 保存したら次の呼び出しから効く。効かないと「保存できたのに効かない」。 */
  it('DB に鍵があれば DB を使う', async () => {
    const resolve = createPaymentConfigResolver({
      integrations: repositoryDouble({
        settings: settings(),
        secrets: { api_key: DB_SECRET_KEY, hmac_secret: DB_WEBHOOK_SECRET },
      }),
      appEnvironment: 'staging',
      fallback: ENV_FALLBACK,
    });
    const result = await resolve();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.source).toBe('database');
      expect(result.config.secretKey).toBe(DB_SECRET_KEY);
      expect(result.config.successUrlTemplate).toBe(COMPLETE.checkoutSuccessUrl);
      expect(result.config.platformFeeRateBps).toBe(2000);
    }
  });

  /*
    ⚠️ いちばん大事な検査。止めたのに環境変数へ落ちると、
       管理画面の「停止」が効かない。事故を止める操作が効かないのが
       いちばん困る。
  */
  it('DB 側で止めてあれば、環境変数へ落ちない', async () => {
    const resolve = createPaymentConfigResolver({
      integrations: repositoryDouble({
        settings: settings({ enabled: false }),
        secrets: { api_key: DB_SECRET_KEY, hmac_secret: DB_WEBHOOK_SECRET },
      }),
      appEnvironment: 'staging',
      fallback: ENV_FALLBACK,
    });
    const result = await resolve();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('disabled');
    }
  });

  /* 署名鍵が無いと、支払い口は作れても入金を確定できない。 */
  it('署名鍵が欠けていれば使わない', async () => {
    const resolve = createPaymentConfigResolver({
      integrations: repositoryDouble({
        settings: settings(),
        secrets: { api_key: DB_SECRET_KEY },
      }),
      appEnvironment: 'staging',
      fallback: ENV_FALLBACK,
    });
    const result = await resolve();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('incomplete');
    }
  });

  it('手数料率 0 のままなら使わない', async () => {
    const resolve = createPaymentConfigResolver({
      integrations: repositoryDouble({
        settings: settings({ payment: { ...COMPLETE, platformFeeRateBps: 0 } }),
        secrets: { api_key: DB_SECRET_KEY, hmac_secret: DB_WEBHOOK_SECRET },
      }),
      appEnvironment: 'staging',
      fallback: ENV_FALLBACK,
    });
    const result = await resolve();
    expect(result.ok).toBe(false);
  });

  it('保管庫が無ければ環境変数で動く', async () => {
    const resolve = createPaymentConfigResolver({
      integrations: null,
      appEnvironment: 'staging',
      fallback: ENV_FALLBACK,
    });
    const result = await resolve();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.source).toBe('environment');
    }
  });

  it('保管庫も環境変数も無ければ、決済できない', async () => {
    const resolve = createPaymentConfigResolver({
      integrations: null,
      appEnvironment: 'staging',
      fallback: null,
    });
    expect((await resolve()).ok).toBe(false);
  });
});

describe('解決するゲートウェイ', () => {
  function build(calls: string[]) {
    return (config: { readonly secretKey: string }) => {
      calls.push(config.secretKey);
      return {
        provider: 'stub',
        createCheckoutSession: async () => ({ ok: true as const, value: null as never }),
        verifyAndParseWebhook: async () => ({ ok: true as const, value: null as never }),
      };
    };
  }

  /* 同じ設定なら作り直さない。事業者の SDK は接続を内部に抱える。 */
  it('設定が同じなら作り直さない', async () => {
    const calls: string[] = [];
    let secret = DB_SECRET_KEY;
    const gateway = new ResolvingPaymentGateway(
      async () => ({
        ok: true,
        config: { ...ENV_FALLBACK, secretKey: secret, source: 'database' as const },
      }),
      build(calls),
      'stub',
    );

    await gateway.currentConfig();
    await gateway.verifyAndParseWebhook(Buffer.from('{}'), 'sig');
    await gateway.verifyAndParseWebhook(Buffer.from('{}'), 'sig');
    expect(calls).toHaveLength(1);

    /* 鍵を差し替えたら、次の呼び出しから新しいほうで作り直す。 */
    secret = `${PAYMENT_TEST_KEY_PREFIX}ROTATED`;
    await gateway.verifyAndParseWebhook(Buffer.from('{}'), 'sig');
    expect(calls).toHaveLength(2);
  });

  /* 止めてあることと、設定が足りないことを分けて返す。直し方が違う。 */
  it('止めてあるときは、その旨の符号を返す', async () => {
    const gateway = new ResolvingPaymentGateway(
      async () => ({ ok: false, reason: 'disabled' }),
      build([]),
      'stub',
    );
    const result = await gateway.verifyAndParseWebhook(Buffer.from('{}'), 'sig');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PAYMENT_PROVIDER_DISABLED');
    }
  });

  it('設定が足りないときは、販売設定未完了として返す', async () => {
    const gateway = new ResolvingPaymentGateway(
      async () => ({ ok: false, reason: 'incomplete' }),
      build([]),
      'stub',
    );
    const result = await gateway.createCheckoutSession({} as never);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('SALES_SETUP_INCOMPLETE');
    }
  });
});

describe('販売設定の完了判定', () => {
  it('0 は未完了', () => {
    expect(isSalesSetupComplete({ ...COMPLETE, platformFeeRateBps: 0 })).toBe(false);
  });
});
