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
  type PaymentCredentialGeneration,
  type PaymentSettingsFields,
} from '@sengoku/domain';
import {
  createPaymentConfigByCredentialResolver,
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
      ...RESOLVER_DEFAULTS,
      credentials: credentialsDouble(),
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

/**
 * 世代の表の代替（`UD-128`）。
 *
 * ⚠️ **既定で 1 世代が受付中。** 鍵は世代から読むのが通常経路なので、
 * 何も指定しない試験は「世代がある」状態で走るのが正しい。
 */
function credentialsDouble(
  options: {
    readonly secretKey?: string;
    readonly webhookSecret?: string;
    readonly accepting?: boolean;
    readonly generations?: number;
  } = {},
) {
  const count = options.generations ?? 1;
  const rows: PaymentCredentialGeneration[] = Array.from({ length: count }, (_, index) => ({
    id: `cred-${String(index + 1)}`,
    provider: 'stripe',
    environment: 'staging',
    generation: index + 1,
    status: 'active',
    accountRef: 'acct_test',
    label: null,
    apiVersion: null,
    lastCheckSucceeded: true,
    lastCheckAt: new Date('2026-08-01T00:00:00.000Z'),
    lastWebhookReceivedAt: null,
    // ⚠️ 受付は最後の 1 件だけ。2 つ受付中だと `acceptingGeneration` が
    //    選ばない（入金先が不定になるので、分からないなら止める）。
    acceptsNewPayments: (options.accepting ?? true) && index === count - 1,
    activatedAt: new Date('2026-08-01T00:00:00.000Z'),
    retiredAt: null,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
  }));
  return {
    list: () => Promise.resolve(rows),
    open: (id: string) =>
      Promise.resolve(
        rows.some((row) => row.id === id)
          ? {
              id,
              generation: 1,
              secretKey: options.secretKey ?? DEPLOYMENT.secretKey,
              webhookSecret: options.webhookSecret ?? DEPLOYMENT.webhookSecret,
              apiVersion: null,
            }
          : null,
      ),
    openForVerification: () =>
      Promise.resolve(
        rows.map((row) => ({
          id: row.id,
          generation: row.generation,
          secretKey: options.secretKey ?? DEPLOYMENT.secretKey,
          webhookSecret: options.webhookSecret ?? DEPLOYMENT.webhookSecret,
          apiVersion: null,
        })),
      ),
  };
}

/** 通常経路の既定値。⚠️ 緊急上書きは既定で `false`。 */
const RESOLVER_DEFAULTS = {
  provider: 'stripe',
  emergencyOverride: false,
} as const;

describe('決済設定の解決', () => {
  it('受付中の世代の鍵を使う（`UD-128`）', async () => {
    const resolve = createPaymentConfigResolver({
      ...RESOLVER_DEFAULTS,
      credentials: credentialsDouble({ secretKey: `${PAYMENT_TEST_KEY_PREFIX}from_generation` }),
      integrations: repositoryDouble(settings()),
      appEnvironment: 'staging',
      deployment: DEPLOYMENT,
    });
    const result = await resolve();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.secretKey).toBe(`${PAYMENT_TEST_KEY_PREFIX}from_generation`);
      expect(result.config.keySource).toBe('generation');
      expect(result.config.credentialId).toBe('cred-1');
    }
  });

  /*
    ⚠️ **`UD-128` でいちばん大事な検査。**
       配備環境に鍵があっても、世代が無ければ決済できない。落ちてしまうと、
       世代を有効化したつもりで環境変数の古い鍵が使われ続ける。
       入金先がずれてから気づくことになり、そのときには売上が別の口座にある。
  */
  it('世代が無ければ、配備環境に鍵があっても決済できない', async () => {
    const resolve = createPaymentConfigResolver({
      ...RESOLVER_DEFAULTS,
      credentials: { ...credentialsDouble(), list: () => Promise.resolve([]) },
      integrations: repositoryDouble(settings()),
      // 鍵は揃っている。それでも落ちてはいけない。
      deployment: DEPLOYMENT,
      appEnvironment: 'staging',
    });
    const result = await resolve();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // ⚠️ `incomplete` と分ける。直し方が違う（設定を埋める／世代を取り込む）。
      expect(result.reason).toBe('no_credential');
    }
  });

  it('世代の表を持たない配備でも、配備環境の鍵へ落ちない', async () => {
    const resolve = createPaymentConfigResolver({
      ...RESOLVER_DEFAULTS,
      credentials: null,
      integrations: repositoryDouble(settings()),
      deployment: DEPLOYMENT,
      appEnvironment: 'staging',
    });
    const result = await resolve();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('no_credential');
    }
  });

  /*
    ⚠️ 受付中が 2 つあるのは、DB の部分UNIQUE が外れたときにしか起きない。
       それでも「たまたま先頭」で入金先を決めない。分からないなら止める。
  */
  it('受付中の世代が 2 つあれば選ばない', async () => {
    const rows = credentialsDouble({ generations: 2 });
    const resolve = createPaymentConfigResolver({
      ...RESOLVER_DEFAULTS,
      credentials: {
        ...rows,
        list: async () => (await rows.list()).map((row) => ({ ...row, acceptsNewPayments: true })),
      },
      integrations: repositoryDouble(settings()),
      deployment: DEPLOYMENT,
      appEnvironment: 'staging',
    });
    const result = await resolve();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('no_credential');
    }
  });

  /*
    緊急上書き。⚠️ **明示的に立てたときだけ**配備環境の鍵を使う。
       黙って落ちる経路ではないことを、ここで縛る。
  */
  it('緊急上書きが立っていれば配備環境の鍵を使う', async () => {
    const resolve = createPaymentConfigResolver({
      ...RESOLVER_DEFAULTS,
      emergencyOverride: true,
      credentials: { ...credentialsDouble(), list: () => Promise.resolve([]) },
      integrations: repositoryDouble(settings()),
      deployment: DEPLOYMENT,
      appEnvironment: 'staging',
    });
    const result = await resolve();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.secretKey).toBe(DEPLOYMENT.secretKey);
      expect(result.config.keySource).toBe('deployment');
      // ⚠️ 世代を通していないので追えない。常用してはいけない理由。
      expect(result.config.credentialId).toBeNull();
    }
  });

  it('緊急上書きでも、配備環境に鍵が無ければ決済できない', async () => {
    const resolve = createPaymentConfigResolver({
      ...RESOLVER_DEFAULTS,
      emergencyOverride: true,
      credentials: credentialsDouble(),
      integrations: repositoryDouble(settings()),
      deployment: { ...DEPLOYMENT, webhookSecret: '' },
      appEnvironment: 'staging',
    });
    const result = await resolve();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('incomplete');
    }
  });

  /* 戻り先は DB が正。保存したら次の呼び出しから効く。 */
  it('DB に戻り先があれば DB を使う', async () => {
    const resolve = createPaymentConfigResolver({
      ...RESOLVER_DEFAULTS,
      credentials: credentialsDouble(),
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
      ...RESOLVER_DEFAULTS,
      credentials: credentialsDouble(),
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
      ...RESOLVER_DEFAULTS,
      credentials: credentialsDouble(),
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
        // ⚠️ この組では返金を見ない。呼ばれたら試験の書き間違い。
        refundPayment: async () => ({ ok: true as const, value: null as never }),
      };
    };
  }

  /** 特定の鍵でだけ署名が通る、擬似のゲートウェイ。 */
  function buildMatching(expected: string, tried: string[]) {
    return (config: { readonly secretKey: string; readonly webhookSecret: string }) => ({
      provider: 'stub',
      refundPayment: async () => ({ ok: true as const, value: null as never }),
      createCheckoutSession: async () => ({
        ok: true as const,
        value: {
          sessionRef: 'cs_1',
          paymentRef: null,
          url: 'https://pay.example/cs_1',
          expiresAt: new Date('2026-08-20T00:00:00.000Z'),
          credentialId: null,
        },
      }),
      verifyAndParseWebhook: async () => {
        tried.push(config.webhookSecret);
        return config.webhookSecret === expected
          ? {
              ok: true as const,
              value: {
                kind: 'ignored' as const,
                eventId: 'evt_1',
                eventType: 'x',
                apiVersion: null,
                livemode: false,
                orderId: null,
                sessionRef: null,
                paymentRef: null,
                chargeRef: null,
                amount: null,
                currency: null,
                failureCode: null,
                refundRef: null,
                refundedTotal: null,
                disputeRef: null,
                disputeStatus: null,
                disputeAmount: null,
                disputeReason: null,
                occurredAt: new Date('2026-08-20T00:00:00.000Z'),
                credentialId: null,
              },
            }
          : { ok: false as const, error: { code: 'WEBHOOK_SIGNATURE_INVALID' as const } };
      },
    });
  }

  function configFor(id: string, webhookSecret: string) {
    return {
      ...DEPLOYMENT,
      webhookSecret,
      settingsSource: 'database' as const,
      keySource: 'generation' as const,
      credentialId: id,
    };
  }

  /*
    ⚠️ **`UD-128` の要。** 切り替えたあとも旧アカウントの知らせは届き続ける。
       受付中の世代だけで判定すると、旧世代の決済が「署名が違う」として
       捨てられ、支払い済みの注文が未払いのまま残る。
  */
  it('旧世代の署名でも、世代を順に試して通す', async () => {
    const tried: string[] = [];
    const gateway = new ResolvingPaymentGateway(
      async () => ({ ok: true, config: configFor('cred-2', 'new') }),
      buildMatching('old', tried),
      'stub',
      async () => [configFor('cred-2', 'new'), configFor('cred-1', 'old')],
    );

    const result = await gateway.verifyAndParseWebhook(Buffer.from('{}'), 'sig');
    expect(result.ok).toBe(true);
    // 新しい順に試している。
    expect(tried).toEqual(['new', 'old']);
    if (result.ok) {
      // ⚠️ どの世代で通ったかを返す。旧アカウント宛の決済に気づく手掛かり。
      expect(result.value.credentialId).toBe('cred-1');
    }
  });

  it('通った世代に印を付ける', async () => {
    const touched: string[] = [];
    const gateway = new ResolvingPaymentGateway(
      async () => ({ ok: true, config: configFor('cred-1', 'old') }),
      buildMatching('old', []),
      'stub',
      async () => [configFor('cred-1', 'old')],
      async (id) => {
        touched.push(id);
      },
    );

    await gateway.verifyAndParseWebhook(Buffer.from('{}'), 'sig');
    expect(touched).toEqual(['cred-1']);
  });

  it('どの世代でも通らなければ失敗する', async () => {
    const gateway = new ResolvingPaymentGateway(
      async () => ({ ok: true, config: configFor('cred-1', 'a') }),
      buildMatching('never', []),
      'stub',
      async () => [configFor('cred-1', 'a'), configFor('cred-2', 'b')],
    );

    const result = await gateway.verifyAndParseWebhook(Buffer.from('{}'), 'sig');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
      /*
        ⚠️ どの世代で落ちたかを外へ出さない。「世代 3 では通った」と
           分かると、鍵の当たりを付ける手掛かりになる。
      */
      expect(JSON.stringify(result.error)).not.toContain('cred-');
    }
  });

  it('支払い口には、作った世代を押す', async () => {
    const gateway = new ResolvingPaymentGateway(
      async () => ({ ok: true, config: configFor('cred-7', 'x') }),
      buildMatching('x', []),
      'stub',
    );
    const created = await gateway.createCheckoutSession({
      orderId: 'order-1',
      amount: 1000,
      currency: 'JPY',
      idempotencyKey: 'key-1',
      expiresAt: new Date('2026-08-20T00:00:00.000Z'),
    } as never);
    expect(created.ok).toBe(true);
    if (created.ok) {
      // ⚠️ これが無いと、その注文は返金できない。
      expect(created.value.credentialId).toBe('cred-7');
    }
  });

  it('世代が無ければ、直し方の分かる符号を返す', async () => {
    const gateway = new ResolvingPaymentGateway(
      async () => ({ ok: false, reason: 'no_credential' }),
      build([]),
      'stub',
    );
    const result = await gateway.verifyAndParseWebhook(Buffer.from('{}'), 'sig');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PAYMENT_CREDENTIAL_CHECK_REQUIRED');
    }
  });

  /* 同じ設定なら作り直さない。事業者の SDK は接続を内部に抱える。 */
  it('設定が同じなら作り直さない', async () => {
    const calls: string[] = [];
    let secret = DEPLOYMENT.secretKey;
    const gateway = new ResolvingPaymentGateway(
      async () => ({
        ok: true,
        config: {
          ...DEPLOYMENT,
          secretKey: secret,
          settingsSource: 'database' as const,
          keySource: 'generation' as const,
          credentialId: 'cred-1',
        },
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

/**
 * 返金は「決済した当時の世代」で投げる（`UD-118` §2 / `UD-120`）。
 *
 * ⚠️ **ここが仕様の要。** `payment_intent` は発行したアカウントに紐づく。
 * 受付中の世代で投げると、運営会社を切り替えたあとに過去の注文を
 * 返金できない——いちばん困る形で穴が開く。
 */
describe('返金の世代', () => {
  const DEPLOYMENT_CONFIG = {
    secretKey: `${PAYMENT_TEST_KEY_PREFIX}NOT_A_REAL_KEY`,
    webhookSecret: 'whsec_NOT_A_REAL_SECRET',
    apiVersion: '2026-07-29.dahlia',
    successUrlTemplate: 'https://env.example.com/orders/{ORDER_ID}',
    cancelUrlTemplate: 'https://env.example.com/orders',
  };

  function configFor(id: string | null, secretKey: string) {
    return {
      ...DEPLOYMENT_CONFIG,
      secretKey,
      settingsSource: 'database' as const,
      keySource: 'generation' as const,
      credentialId: id,
    };
  }

  /** どの鍵で投げられたかを記録する、擬似のゲートウェイ。 */
  function buildRecording(used: string[]) {
    return (config: { readonly secretKey: string }) => ({
      provider: 'stub',
      createCheckoutSession: async () => ({ ok: true as const, value: null as never }),
      verifyAndParseWebhook: async () => ({ ok: true as const, value: null as never }),
      refundPayment: async () => {
        used.push(config.secretKey);
        return {
          ok: true as const,
          value: { refundRef: 're_1', amount: 3000, pending: false },
        };
      },
    });
  }

  const REFUND_INPUT = {
    paymentRef: 'pi_1',
    chargeRef: null,
    amount: 3000,
    currency: 'JPY',
    reason: 'buyer_request' as const,
    idempotencyKey: 'refund_1',
  };

  it('決済した当時の世代の鍵で投げる（受付中の世代ではない）', async () => {
    const used: string[] = [];
    const gateway = new ResolvingPaymentGateway(
      // 受付中はこちら。⚠️ 返金はこの鍵を使ってはいけない。
      async () => ({ ok: true, config: configFor('cred-new', 'sk_new') }),
      buildRecording(used),
      'stub',
      null,
      null,
      async (id: string) =>
        id === 'cred-old'
          ? { ok: true, config: configFor('cred-old', 'sk_old') }
          : { ok: false, reason: 'no_credential' },
    );

    const result = await gateway.refundPayment({ ...REFUND_INPUT, credentialId: 'cred-old' });
    expect(result.ok).toBe(true);
    expect(used).toEqual(['sk_old']);
  });

  it('当時の世代を開けなければ断る（受付中の世代へ落ちない）', async () => {
    /*
      ⚠️ **落ちると、無関係のアカウントへ返金を投げることになる。**
         金額が合っていれば通ってしまい、そのアカウントから現金が出ていく。
         断る方がはるかに軽い。
    */
    const used: string[] = [];
    const gateway = new ResolvingPaymentGateway(
      async () => ({ ok: true, config: configFor('cred-new', 'sk_new') }),
      buildRecording(used),
      'stub',
      null,
      null,
      async () => ({ ok: false, reason: 'no_credential' }),
    );

    const result = await gateway.refundPayment({ ...REFUND_INPUT, credentialId: 'cred-gone' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('REFUND_CREDENTIAL_UNAVAILABLE');
    }
    // ⚠️ 1 度も投げていないこと。
    expect(used).toEqual([]);
  });

  it('世代を通していない決済（緊急上書き・fake）は、いま解決できる設定で投げる', async () => {
    const used: string[] = [];
    const gateway = new ResolvingPaymentGateway(
      async () => ({ ok: true, config: configFor(null, 'sk_current') }),
      buildRecording(used),
      'stub',
      null,
      null,
      async () => ({ ok: false, reason: 'no_credential' }),
    );

    const result = await gateway.refundPayment({ ...REFUND_INPUT, credentialId: null });
    expect(result.ok).toBe(true);
    expect(used).toEqual(['sk_current']);
  });

  it('世代を開く口を渡していなければ、直し方の分かる符号を返す', async () => {
    const gateway = new ResolvingPaymentGateway(
      async () => ({ ok: true, config: configFor('cred-new', 'sk_new') }),
      buildRecording([]),
      'stub',
    );
    const result = await gateway.refundPayment({ ...REFUND_INPUT, credentialId: 'cred-old' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('REFUND_CREDENTIAL_UNAVAILABLE');
      // ⚠️ 鍵が符号にも文面にも出ない。
      expect(JSON.stringify(result.error)).not.toContain('sk_');
    }
  });
});

describe('返金は「止めている」ことを理由に断らない', () => {
  /*
    ⚠️ **止めるのは新規のお支払いであって、返すことではない。** ここで
       `enabled` を見ると、事故を止めるために連携を止めた瞬間に、
       その事故の返金までできなくなる。
  */
  it('世代を開く解決は、連携の停止を見ない', () => {
    const source = createPaymentConfigByCredentialResolver.toString();
    expect(source).not.toContain('enabled');
    expect(source).not.toContain('findSettings');
  });
});

describe('販売設定の完了判定', () => {
  it('0 は未完了', () => {
    expect(isSalesSetupComplete({ ...COMPLETE, platformFeeRateBps: 0 })).toBe(false);
  });
});
