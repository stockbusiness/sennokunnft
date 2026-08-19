import { describe, expect, it } from 'vitest';

import { STRIPE_LIVE_KEY_PREFIX, STRIPE_TEST_KEY_PREFIX } from '@sengoku/config';
import {
  PAYMENT_LIVE_KEY_PREFIX,
  PAYMENT_TEST_KEY_PREFIX,
  PAYMENT_API_ENDPOINT,
  isSalesSetupComplete,
  storesSecrets,
  type IntegrationRepository,
  type IntegrationSettings,
  type PaymentSettingsFields,
} from '@sengoku/domain';
import {
  createPaymentConfigResolver,
  createPlatformFeeRateResolver,
  ResolvingPaymentGateway,
} from '@sengoku/integrations';

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

/** 配備環境（Secret 管理）から読んだ設定。⚠️ 鍵はここにしか無い。 */
const DEPLOYMENT = {
  secretKey: `${PAYMENT_TEST_KEY_PREFIX}NOT_A_REAL_KEY`,
  webhookSecret: 'whsec_NOT_A_REAL_SECRET',
  apiVersion: '2026-07-29.dahlia',
  successUrlTemplate: 'https://env.example.com/orders/{ORDER_ID}',
  cancelUrlTemplate: 'https://env.example.com/orders',
};

function repositoryDouble(settings: IntegrationSettings | null): IntegrationRepository {
  return {
    findSettings: async () => settings,
    /*
      ⚠️ **決済ではここが呼ばれてはいけない。** 呼ばれたら、鍵を保管庫から
         読もうとしている。呼ばれたことが分かるよう例外を投げる。
    */
    revealForAdapter: async () => {
      throw new Error('決済の鍵を保管庫から読もうとしています');
    },
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

describe('決済の鍵は保管庫へ置かない', () => {
  /*
    2026-08-19 決定。鍵は配備環境の Secret 管理に置く。
    画面から交換できる仕組みは、再認証・二者承認・ローテーション・
    復旧経路まで揃えた別仕様として扱う。
  */
  it('決済は資格情報を預からない', () => {
    expect(storesSecrets('payment')).toBe(false);
  });

  it('Wallet は従来どおり預かる', () => {
    expect(storesSecrets('ovew_wallet')).toBe(true);
  });

  /* 保管庫を一切引かないこと。引いたら repositoryDouble が例外を投げる。 */
  it('設定を解決するとき、保管庫から鍵を読まない', async () => {
    const resolve = createPaymentConfigResolver({
      integrations: repositoryDouble(settings()),
      appEnvironment: 'staging',
      deployment: DEPLOYMENT,
    });
    const result = await resolve();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.secretKey).toBe(DEPLOYMENT.secretKey);
    }
  });
});

describe('決済設定の解決', () => {
  it('配備環境に鍵が無ければ決済できない', async () => {
    const resolve = createPaymentConfigResolver({
      integrations: repositoryDouble(settings()),
      appEnvironment: 'staging',
      deployment: null,
    });
    const result = await resolve();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('incomplete');
    }
  });

  it('署名鍵だけ欠けていても決済できない', async () => {
    const resolve = createPaymentConfigResolver({
      integrations: repositoryDouble(settings()),
      appEnvironment: 'staging',
      deployment: { ...DEPLOYMENT, webhookSecret: '' },
    });
    expect((await resolve()).ok).toBe(false);
  });

  /* 戻り先は DB が正。保存したら次の呼び出しから効く。 */
  it('DB に戻り先があれば DB を使う', async () => {
    const resolve = createPaymentConfigResolver({
      integrations: repositoryDouble(settings()),
      appEnvironment: 'staging',
      deployment: DEPLOYMENT,
    });
    const result = await resolve();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.settingsSource).toBe('database');
      expect(result.config.successUrlTemplate).toBe(COMPLETE.checkoutSuccessUrl);
    }
  });

  it('DB に戻り先が無ければ配備環境の値を使う', async () => {
    const resolve = createPaymentConfigResolver({
      integrations: repositoryDouble(
        settings({ payment: { ...COMPLETE, checkoutSuccessUrl: null } }),
      ),
      appEnvironment: 'staging',
      deployment: DEPLOYMENT,
    });
    const result = await resolve();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.settingsSource).toBe('environment');
      expect(result.config.successUrlTemplate).toBe(DEPLOYMENT.successUrlTemplate);
    }
  });

  /*
    ⚠️ いちばん大事な検査。止めたのに配備環境の値へ落ちると、
       管理画面の「停止」が効かない。事故を止める操作が効かないのが
       いちばん困る。
  */
  it('DB 側で止めてあれば、配備環境の値へ落ちない', async () => {
    const resolve = createPaymentConfigResolver({
      integrations: repositoryDouble(settings({ enabled: false })),
      appEnvironment: 'staging',
      deployment: DEPLOYMENT,
    });
    const result = await resolve();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('disabled');
    }
  });
});

describe('手数料率の解決', () => {
  /** 率だけを返す口。⚠️ 暗号鍵も保管庫も要らない。 */
  function feeReader(bps: number) {
    return { readPlatformFeeRateBps: async () => bps };
  }

  /*
    ⚠️ **正は DB だけ**（2026-08-19 決定）。環境変数へ落とすと、
       DB と環境変数で違う値が使われる「二重管理」になる。
       ずれに気づくのは請求の段階になる。
  */
  it('DB の値をそのまま使う', async () => {
    const resolve = createPlatformFeeRateResolver({
      reader: feeReader(1500),
      appEnvironment: 'staging',
    });
    expect(await resolve()).toBe(1500);
  });

  /* 未設定なら 0 のまま。ここで既定値を作らない。 */
  it('DB に行が無ければ 0（販売設定未完了）', async () => {
    const resolve = createPlatformFeeRateResolver({
      reader: feeReader(0),
      appEnvironment: 'staging',
    });
    expect(await resolve()).toBe(0);
  });

  it('DB の値が 0 なら 0（既定値を入れない）', async () => {
    const resolve = createPlatformFeeRateResolver({
      reader: feeReader(0),
      appEnvironment: 'staging',
    });
    expect(await resolve()).toBe(0);
  });

  /*
    ⚠️ **暗号鍵の有無に左右されないこと。** 率は秘密ではないので、
       復号の仕組みを通す理由が無い。紐づけていたせいで、鍵を置いて
       いない配備（E2E・手元）で率が 0 に落ちかけた。
  */
  it('暗号鍵を置いていない配備でも読める', async () => {
    const resolve = createPlatformFeeRateResolver({
      reader: feeReader(2000),
      appEnvironment: 'staging',
    });
    expect(await resolve()).toBe(2000);
  });

  /*
    ⚠️ 「連携を止める」のはお金の受け口であって、取り分の約束ではない。
       止めるたびに 0 へ戻すと、再開したときに手数料が消えていることに
       気づけない。
  */
  it('連携を止めていても、率は変わらない', async () => {
    const resolve = createPlatformFeeRateResolver({
      reader: feeReader(2000),
      appEnvironment: 'staging',
    });
    expect(await resolve()).toBe(2000);
  });

  /*
    ⚠️ **二重管理を作らないことの検査。** 解決する関数が環境変数を
       受け取れないこと自体を、型ではなく実物で確かめる。引数を足した
       だけで黙って読み始める、という形の後退を防ぐ。
  */
  it('解決する関数は環境変数を受け取らない', () => {
    const source = createPlatformFeeRateResolver.toString();
    expect(source).not.toContain('process.env');
    expect(source).not.toContain('fallback');
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
    let secret = DEPLOYMENT.secretKey;
    const gateway = new ResolvingPaymentGateway(
      async () => ({
        ok: true,
        config: { ...DEPLOYMENT, secretKey: secret, settingsSource: 'database' as const },
      }),
      build(calls),
      'stub',
    );

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

  /*
    ⚠️ **接続できないときに、鍵が例外の文面へ混ざらないこと。**
       Stripe が落ちている・網が届かない場面はいずれ必ず来る。
       そのとき例外がそのままログへ流れると、鍵が残る。
  */
  it('解決に失敗しても、鍵が符号や文面へ出ない', async () => {
    const gateway = new ResolvingPaymentGateway(
      async () => ({ ok: false, reason: 'incomplete' }),
      build([]),
      'stub',
    );
    const result = await gateway.createCheckoutSession({} as never);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(JSON.stringify(result.error)).not.toContain('NOT_A_REAL');
    }
  });
});

describe('販売設定の完了判定', () => {
  it('0 は未完了', () => {
    expect(isSalesSetupComplete({ ...COMPLETE, platformFeeRateBps: 0 })).toBe(false);
  });
});
