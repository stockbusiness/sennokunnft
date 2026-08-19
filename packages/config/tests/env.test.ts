import { describe, expect, it } from 'vitest';
import {
  apiEnvSchema,
  workerEnvSchema,
  webEnvSchema,
  parseEnv,
  loadEnv,
  formatEnvProblems,
  assertPhaseOneIntegrationLimits,
  assertStripeConfig,
  STRIPE_TEST_KEY_PREFIX,
  STRIPE_LIVE_KEY_PREFIX,
  assertProductionSafety,
  assertCommonUserLinkingConfig,
  assertClaimApiConfig,
  assertMediaStorageConfig,
  assertSupabaseAuthConfig,
  parseHmacKeys,
  UnsafeEnvironmentError,
} from '../src/index';

const MINIMAL_API_ENV = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/sengoku',
};

describe('parseEnv', () => {
  it('必須変数が揃っていれば成功する', () => {
    const result = parseEnv(apiEnvSchema, MINIMAL_API_ENV as NodeJS.ProcessEnv);
    expect(result.ok).toBe(true);
  });

  it('既定値が適用される', () => {
    const result = parseEnv(apiEnvSchema, MINIMAL_API_ENV as NodeJS.ProcessEnv);
    if (!result.ok) throw new Error('expected success');
    expect(result.env.API_PORT).toBe(3001);
    expect(result.env.APP_ENV).toBe('local');
    expect(result.env.LOG_LEVEL).toBe('info');
    // 未決定事項（UD-501 / UD-702）のため、既定は必ず fake。
    expect(result.env.PAYMENT_PROVIDER).toBe('fake');
    expect(result.env.MINT_PROVIDER).toBe('fake');
  });

  it('必須変数が欠けていると失敗し、変数名を報告する', () => {
    const result = parseEnv(apiEnvSchema, {} as NodeJS.ProcessEnv);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.problems.map((p) => p.variable)).toContain('DATABASE_URL');
  });

  it('.env.example をコピーした直後の空文字は「未設定」として扱う', () => {
    // `API_PORT=` のような空値で既定値が効かないと、不親切なエラーになる。
    const result = parseEnv(apiEnvSchema, {
      ...MINIMAL_API_ENV,
      API_PORT: '',
      LOG_LEVEL: '',
    } as NodeJS.ProcessEnv);
    if (!result.ok) throw new Error('expected success');
    expect(result.env.API_PORT).toBe(3001);
    expect(result.env.LOG_LEVEL).toBe('info');
  });

  it('範囲外のポート番号を拒否する', () => {
    const result = parseEnv(apiEnvSchema, {
      ...MINIMAL_API_ENV,
      API_PORT: '99999',
    } as NodeJS.ProcessEnv);
    expect(result.ok).toBe(false);
  });

  it('worker / web のスキーマも必須変数を検証する', () => {
    expect(parseEnv(workerEnvSchema, {} as NodeJS.ProcessEnv).ok).toBe(false);
    // web には必須変数がないため、空でも既定値で成立する。
    const web = parseEnv(webEnvSchema, {} as NodeJS.ProcessEnv);
    if (!web.ok) throw new Error('expected success');
    expect(web.env.WEB_API_BASE_URL).toBe('http://localhost:3001');
  });

  it('サイト名の既定値をここに置かない（UD-101）', () => {
    // ⚠️ 暫定名の置き場所は apps/web/src/site.ts の 1 か所だけ。
    //    ここにも既定値を書くと、同じ画面に 2 つの製品名が同時に出る。
    //    実際に「見出しはこの既定値・タブ名とフッタは site.ts」という
    //    状態になっていた。落ちも警告も出ないので気づけない。
    const web = parseEnv(webEnvSchema, {} as NodeJS.ProcessEnv);
    if (!web.ok) throw new Error('expected success');
    expect(web.env.NEXT_PUBLIC_SITE_NAME).toBeUndefined();
  });

  it('サイト名は設定されていればそれを使う', () => {
    const web = parseEnv(webEnvSchema, {
      NEXT_PUBLIC_SITE_NAME: '正式名',
    } as unknown as NodeJS.ProcessEnv);
    if (!web.ok) throw new Error('expected success');
    expect(web.env.NEXT_PUBLIC_SITE_NAME).toBe('正式名');
  });
});

describe('エラー出力に値を含めない（SECURITY_DESIGN §3.3）', () => {
  it('検証エラーに環境変数の値が現れない', () => {
    const secret = 'super-secret-connection-string-value';
    const result = parseEnv(apiEnvSchema, {
      DATABASE_URL: secret,
      API_PORT: 'not-a-number',
    } as NodeJS.ProcessEnv);
    if (result.ok) throw new Error('expected failure');

    const rendered = formatEnvProblems(result.problems);
    expect(rendered).toContain('API_PORT');
    expect(rendered).not.toContain(secret);
    expect(rendered).not.toContain('not-a-number');
  });
});

describe('loadEnv', () => {
  it('検証失敗時に致命ハンドラを呼ぶ（不完全な設定で起動させない）', () => {
    let fatalMessage: string | undefined;
    expect(() =>
      loadEnv(apiEnvSchema, {} as NodeJS.ProcessEnv, {
        onFatal: (message) => {
          fatalMessage = message;
          throw new Error('fatal');
        },
      }),
    ).toThrow('fatal');
    expect(fatalMessage).toContain('DATABASE_URL');
  });

  it('成功時は検証済みの値を返す', () => {
    const env = loadEnv(apiEnvSchema, MINIMAL_API_ENV as NodeJS.ProcessEnv);
    expect(env.DATABASE_URL).toBe(MINIMAL_API_ENV.DATABASE_URL);
  });
});

describe('assertPhaseOneIntegrationLimits', () => {
  it('プロバイダが fake なら通過する', () => {
    expect(() =>
      assertPhaseOneIntegrationLimits({
        APP_ENV: 'local',
        LOG_LEVEL: 'info',
        PAYMENT_PROVIDER: 'fake',
        MINT_PROVIDER: 'fake',
      }),
    ).not.toThrow();
  });

  it('決済は stripe を通す（決済 Phase P2 で決定）', () => {
    expect(() =>
      assertPhaseOneIntegrationLimits({
        APP_ENV: 'local',
        LOG_LEVEL: 'info',
        PAYMENT_PROVIDER: 'stripe',
      }),
    ).not.toThrow();
  });

  it('知らない決済事業者は拒否する', () => {
    expect(() =>
      assertPhaseOneIntegrationLimits({
        APP_ENV: 'local',
        LOG_LEVEL: 'info',
        PAYMENT_PROVIDER: 'paypal',
      }),
    ).toThrow(UnsafeEnvironmentError);
  });

  it('発行のプロバイダは開けていない', () => {
    // ⚠️ 決済と一緒に緩めない。チェーンは未決（UD-501）で、
    //    ここが開くと「1 行足すだけで本番のチェーンへ繋がる」道ができる。
    expect(() =>
      assertPhaseOneIntegrationLimits({
        APP_ENV: 'local',
        LOG_LEVEL: 'info',
        MINT_PROVIDER: 'polygon',
      }),
    ).toThrow(UnsafeEnvironmentError);
  });
});

describe('assertStripeConfig', () => {
  /*
    ⚠️ **鍵らしき文字列を直接書かない。** 秘密の直書き検査
       （`check-secrets.mjs`）が引っかかる。検査を緩めるのではなく、
       引っかからない書き方をする。接頭辞は実装から借りる。
  */
  const TEST_KEY = `${STRIPE_TEST_KEY_PREFIX}dummyvalueforunittest`;
  const LIVE_KEY = `${STRIPE_LIVE_KEY_PREFIX}dummyvalueforunittest`;

  const COMPLETE = {
    APP_ENV: 'staging',
    PAYMENT_PROVIDER: 'stripe',
    STRIPE_SECRET_KEY: TEST_KEY,
    STRIPE_WEBHOOK_SECRET: 'whsec_dummyvalueforunittest',
    STRIPE_CHECKOUT_SUCCESS_URL: 'https://example.test/orders/{ORDER_ID}',
    STRIPE_CHECKOUT_CANCEL_URL: 'https://example.test/orders/{ORDER_ID}',
  } as const;

  it('fake のときは何も要求しない', () => {
    // 鍵を持たない人の開発を止めない。
    expect(() => {
      assertStripeConfig({ APP_ENV: 'local', PAYMENT_PROVIDER: 'fake' });
    }).not.toThrow();
  });

  it('揃っていれば通過する', () => {
    expect(() => {
      assertStripeConfig(COMPLETE);
    }).not.toThrow();
  });

  it('鍵が欠けていれば拒否する', () => {
    expect(() => {
      assertStripeConfig({ ...COMPLETE, STRIPE_SECRET_KEY: undefined });
    }).toThrow(UnsafeEnvironmentError);
  });

  it('Webhook の秘密が欠けていれば拒否する', () => {
    // ⚠️ 無いまま起動すると、署名を確かめずに受けるか、全部拒否するかの
    //    どちらかになる。前者は偽の決済成功を受け入れる。
    expect(() => {
      assertStripeConfig({ ...COMPLETE, STRIPE_WEBHOOK_SECRET: undefined });
    }).toThrow(UnsafeEnvironmentError);
  });

  it('production でテスト鍵を拒否する', () => {
    // 決済は全部通ったように見えて、入金が 1 円も無い。
    expect(() => {
      assertStripeConfig({ ...COMPLETE, APP_ENV: 'production' });
    }).toThrow(UnsafeEnvironmentError);
  });

  it('staging で本番鍵を拒否する', () => {
    // ⚠️ こちらのほうが重い。動作確認のつもりで本物のお金が動く。
    expect(() => {
      assertStripeConfig({ ...COMPLETE, STRIPE_SECRET_KEY: LIVE_KEY });
    }).toThrow(UnsafeEnvironmentError);
  });

  it('production で本番鍵は通す', () => {
    expect(() => {
      assertStripeConfig({
        ...COMPLETE,
        APP_ENV: 'production',
        STRIPE_SECRET_KEY: LIVE_KEY,
      });
    }).not.toThrow();
  });

  it('秘密鍵でない値を拒否する', () => {
    // 公開鍵（pk_）や制限付きキー（rk_）を入れた場合。
    expect(() => {
      assertStripeConfig({ ...COMPLETE, STRIPE_SECRET_KEY: 'pk_test_dummyvalueforunittest' });
    }).toThrow(UnsafeEnvironmentError);
  });

  it('理由に鍵の値を含めない', () => {
    // ⚠️ 起動ログは広く共有される。
    const secret = LIVE_KEY;
    try {
      assertStripeConfig({ ...COMPLETE, STRIPE_SECRET_KEY: secret });
      throw new Error('拒否されるはず');
    } catch (error) {
      expect(error).toBeInstanceOf(UnsafeEnvironmentError);
      expect(JSON.stringify((error as UnsafeEnvironmentError).reasons)).not.toContain(secret);
    }
  });
});

describe('assertProductionSafety', () => {
  it('本番以外では何も検査しない', () => {
    expect(() =>
      assertProductionSafety({
        APP_ENV: 'local',
        LOG_LEVEL: 'debug',
        DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      }),
    ).not.toThrow();
  });

  it('本番で debug ログを拒否する', () => {
    expect(() => assertProductionSafety({ APP_ENV: 'production', LOG_LEVEL: 'debug' })).toThrow(
      UnsafeEnvironmentError,
    );
  });

  it('本番でローカルホストを指す DB 接続を拒否する', () => {
    expect(() =>
      assertProductionSafety({
        APP_ENV: 'production',
        LOG_LEVEL: 'info',
        DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/db',
      }),
    ).toThrow(UnsafeEnvironmentError);
  });

  it('例外メッセージに接続文字列を含めない', () => {
    const url = 'postgresql://admin:hunter2@localhost:5432/db';
    try {
      assertProductionSafety({ APP_ENV: 'production', LOG_LEVEL: 'info', DATABASE_URL: url });
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(UnsafeEnvironmentError);
      expect((error as Error).message).not.toContain('hunter2');
      expect((error as Error).message).not.toContain(url);
    }
  });
});

describe('本番での開発用トークン検証の拒否（Phase 2 で追加）', () => {
  it('本番で AUTH_PROVIDER=dev なら起動を拒否する', () => {
    // 開発用の検証は誰でもトークンを作れる。本番で有効になれば認証が無いに等しい。
    expect(() =>
      assertProductionSafety({ APP_ENV: 'production', LOG_LEVEL: 'info', AUTH_PROVIDER: 'dev' }),
    ).toThrow(UnsafeEnvironmentError);
  });

  it('本番以外では dev を許す', () => {
    expect(() =>
      assertProductionSafety({ APP_ENV: 'local', LOG_LEVEL: 'info', AUTH_PROVIDER: 'dev' }),
    ).not.toThrow();
  });

  it('AUTH_PROVIDER の既定値は dev', () => {
    const result = parseEnv(apiEnvSchema, MINIMAL_API_ENV as NodeJS.ProcessEnv);
    if (!result.ok) throw new Error('expected success');
    expect(result.env.AUTH_PROVIDER).toBe('dev');
  });

  it('supabase を受け付ける（UD-801 決定済 2026-08-18: JWKS / ES256）', () => {
    const result = parseEnv(apiEnvSchema, {
      ...MINIMAL_API_ENV,
      AUTH_PROVIDER: 'supabase',
    } as NodeJS.ProcessEnv);
    expect(result.ok).toBe(true);
  });

  it('知らない検証方式は拒否する', () => {
    // ⚠️ 綴り違いを通すと、意図せず dev のまま動きうる。
    const result = parseEnv(apiEnvSchema, {
      ...MINIMAL_API_ENV,
      AUTH_PROVIDER: 'supabse',
    } as NodeJS.ProcessEnv);
    expect(result.ok).toBe(false);
  });
});

describe('共通顧客HUB連携の設定ガード', () => {
  it('無効なら何も要求しない', () => {
    expect(() =>
      assertCommonUserLinkingConfig({ COMMON_USER_LINKING_ENABLED: false }),
    ).not.toThrow();
  });

  it('有効なのに接続先が無ければ起動を拒否する', () => {
    // 起動させると全件が PENDING に積み上がるが、購入は続くので誰も気付かない。
    expect(() =>
      assertCommonUserLinkingConfig({
        COMMON_USER_LINKING_ENABLED: true,
        COMMON_USER_API_KEY: 'a-real-key',
      }),
    ).toThrow(UnsafeEnvironmentError);
  });

  it('有効なのに鍵が無ければ起動を拒否する', () => {
    expect(() =>
      assertCommonUserLinkingConfig({
        COMMON_USER_LINKING_ENABLED: true,
        COMMON_USER_API_BASE_URL: 'https://agency.test',
      }),
    ).toThrow(UnsafeEnvironmentError);
  });

  it('揃っていれば通る', () => {
    expect(() =>
      assertCommonUserLinkingConfig({
        COMMON_USER_LINKING_ENABLED: true,
        COMMON_USER_API_BASE_URL: 'https://agency.test',
        COMMON_USER_API_KEY: 'a-real-key',
      }),
    ).not.toThrow();
  });

  it('拒否の理由に鍵の値を含めない', () => {
    try {
      assertCommonUserLinkingConfig({
        COMMON_USER_LINKING_ENABLED: true,
        COMMON_USER_API_KEY: 'super-secret-key-value',
      });
    } catch (error) {
      expect(String(error)).not.toContain('super-secret-key-value');
    }
  });
});

describe('Claim API の設定検査', () => {
  it('既定は無効（指示書 §15: Feature Flag 既定 ON を禁止）', () => {
    const env = parseEnv(apiEnvSchema, MINIMAL_API_ENV);
    expect(env.ok).toBe(true);
    if (env.ok) {
      expect(env.env.CLAIM_API_ENABLED).toBe(false);
    }
  });

  it('無効なら鍵が無くても通る', () => {
    expect(() => assertClaimApiConfig({ CLAIM_API_ENABLED: false })).not.toThrow();
  });

  it('有効なのに鍵が無ければ起動を拒否する', () => {
    // 起動させると相手の要求が全部 403 で落ち、攻撃と設定漏れの区別がつかない。
    expect(() => assertClaimApiConfig({ CLAIM_API_ENABLED: true })).toThrow(UnsafeEnvironmentError);
  });

  it('鍵の形が壊れていれば起動を拒否する', () => {
    // 値はあるが 1 本も読めない、が最も気づきにくい。
    expect(() =>
      assertClaimApiConfig({ CLAIM_API_ENABLED: true, CLAIM_HMAC_KEYS: 'no-separator' }),
    ).toThrow(UnsafeEnvironmentError);
  });

  it('揃っていれば通る', () => {
    expect(() =>
      assertClaimApiConfig({ CLAIM_API_ENABLED: true, CLAIM_HMAC_KEYS: 'key-1:secret-1' }),
    ).not.toThrow();
  });

  it('拒否の理由に秘密鍵の値を含めない', () => {
    try {
      assertClaimApiConfig({ CLAIM_API_ENABLED: true, CLAIM_HMAC_KEYS: 'broken super-secret' });
    } catch (error) {
      expect(String(error)).not.toContain('super-secret');
    }
  });
});

describe('HMAC 鍵の読み取り', () => {
  it('複数の鍵を読める（入れ替え中は新旧どちらも受け取る）', () => {
    expect(parseHmacKeys('a:1,b:2')).toEqual({ a: '1', b: '2' });
  });

  it('秘密鍵に : が含まれても壊れない', () => {
    expect(parseHmacKeys('a:hello:world')).toEqual({ a: 'hello:world' });
  });

  it('空白や空項目を捨てる', () => {
    expect(parseHmacKeys(' a : 1 , , b:2 ')).toEqual({ a: '1', b: '2' });
  });

  it('区切りの無い項目は採用しない', () => {
    expect(parseHmacKeys('nokey')).toEqual({});
  });

  it('鍵IDまたは秘密鍵が空の項目は採用しない', () => {
    expect(parseHmacKeys(':secret,key:')).toEqual({});
  });
});

describe('画像の保存先の設定検査（UD-508）', () => {
  const R2_ENV = {
    MEDIA_STORAGE_PROVIDER: 'r2',
    MEDIA_PUBLIC_BASE_URL: 'https://media-stg.example.jp',
    R2_ACCOUNT_ID: 'acct',
    R2_BUCKET: 'bucket',
    R2_ACCESS_KEY_ID: 'key',
    R2_SECRET_ACCESS_KEY: 'secret-value',
  };

  it('local なら何も要求しない', () => {
    expect(() => {
      assertMediaStorageConfig({ MEDIA_STORAGE_PROVIDER: 'local' });
    }).not.toThrow();
  });

  it('r2 で全部そろっていれば通す', () => {
    expect(() => {
      assertMediaStorageConfig(R2_ENV);
    }).not.toThrow();
  });

  // ⚠️ 欠けたまま起動すると、画像のアップロードだけが失敗する。
  //    カタログの登録は途中まで進むので「画像の無い作品」ができ、
  //    Wallet へ配送する段になって初めて表面化する。
  it.each([
    'MEDIA_PUBLIC_BASE_URL',
    'R2_ACCOUNT_ID',
    'R2_BUCKET',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
  ] as const)('r2 で %s が無ければ起動させない', (missing) => {
    expect(() => {
      assertMediaStorageConfig({ ...R2_ENV, [missing]: undefined });
    }).toThrow(UnsafeEnvironmentError);
  });

  it('公開URLが https でなければ起動させない', () => {
    expect(() => {
      assertMediaStorageConfig({ ...R2_ENV, MEDIA_PUBLIC_BASE_URL: 'http://media.example.jp' });
    }).toThrow(UnsafeEnvironmentError);
  });

  it('理由に値を含めない', () => {
    try {
      assertMediaStorageConfig({ ...R2_ENV, MEDIA_PUBLIC_BASE_URL: 'http://media.example.jp' });
      throw new Error('should have thrown');
    } catch (error) {
      const text =
        error instanceof UnsafeEnvironmentError ? error.reasons.join(' ') : String(error);
      expect(text).not.toContain('media.example.jp');
      expect(text).not.toContain('secret-value');
    }
  });
});

describe('Supabase での検証に必要な設定（UD-801）', () => {
  const SUPABASE_ENV = {
    APP_ENV: 'staging' as const,
    AUTH_PROVIDER: 'supabase',
    SUPABASE_JWT_ISSUER: 'https://example.supabase.co/auth/v1',
    SUPABASE_JWT_AUDIENCE: 'authenticated',
    SUPABASE_JWKS_URL: 'https://example.supabase.co/auth/v1/.well-known/jwks.json',
  };

  it('dev なら何も要求しない', () => {
    expect(() => {
      assertSupabaseAuthConfig({ AUTH_PROVIDER: 'dev' });
    }).not.toThrow();
  });

  it('supabase で全部そろっていれば通す', () => {
    expect(() => {
      assertSupabaseAuthConfig(SUPABASE_ENV);
    }).not.toThrow();
  });

  // ⚠️ 欠けたまま起動すると、すべてのログインが 401 になる。
  //    利用者からは「自分の入力が悪い」ようにしか見えず、諦めるまで直らない。
  it.each(['SUPABASE_JWT_ISSUER', 'SUPABASE_JWT_AUDIENCE', 'SUPABASE_JWKS_URL'] as const)(
    'supabase で %s が無ければ起動させない',
    (missing) => {
      expect(() => {
        assertSupabaseAuthConfig({ ...SUPABASE_ENV, [missing]: undefined });
      }).toThrow(UnsafeEnvironmentError);
    },
  );

  // ⚠️ 平文で鍵束を取りに行くと、経路上で差し替えられる。
  //    差し替えられた鍵で検証が通れば、偽のトークンを本物として受け入れる。
  it.each(['SUPABASE_JWKS_URL', 'SUPABASE_JWT_ISSUER'] as const)(
    '配備先で %s が https でなければ起動させない',
    (name) => {
      expect(() => {
        assertSupabaseAuthConfig({ ...SUPABASE_ENV, [name]: 'http://example.supabase.co/auth/v1' });
      }).toThrow(UnsafeEnvironmentError);
    },
  );

  it.each(['local', 'test'] as const)('手元（%s）では http を許す', (appEnv) => {
    // ⚠️ Supabase のローカル開発環境は http で動く。全環境で https を
    //    必須にすると、認証だけ手元で試せなくなり、検証されないまま本番へ出る。
    expect(() => {
      assertSupabaseAuthConfig({
        ...SUPABASE_ENV,
        APP_ENV: appEnv,
        SUPABASE_JWKS_URL: 'http://127.0.0.1:54321/auth/v1/.well-known/jwks.json',
        SUPABASE_JWT_ISSUER: 'http://127.0.0.1:54321/auth/v1',
      });
    }).not.toThrow();
  });

  it('手元でも設定そのものが欠けていれば起動させない', () => {
    expect(() => {
      assertSupabaseAuthConfig({
        ...SUPABASE_ENV,
        APP_ENV: 'local',
        SUPABASE_JWKS_URL: undefined,
      });
    }).toThrow(UnsafeEnvironmentError);
  });

  it('理由に値そのものを載せない（ホスト名が混ざる）', () => {
    try {
      assertSupabaseAuthConfig({
        ...SUPABASE_ENV,
        SUPABASE_JWKS_URL: 'http://secret-host.example',
      });
      throw new Error('expected throw');
    } catch (error) {
      expect(String(error)).not.toContain('secret-host');
    }
  });
});
