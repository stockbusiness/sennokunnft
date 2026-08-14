import { describe, expect, it } from 'vitest';
import {
  apiEnvSchema,
  workerEnvSchema,
  webEnvSchema,
  parseEnv,
  loadEnv,
  formatEnvProblems,
  assertPhaseOneIntegrationLimits,
  assertProductionSafety,
  assertCommonUserLinkingConfig,
  assertClaimApiConfig,
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

  it('実サービスを指すプロバイダを拒否する', () => {
    expect(() =>
      assertPhaseOneIntegrationLimits({
        APP_ENV: 'local',
        LOG_LEVEL: 'info',
        PAYMENT_PROVIDER: 'stripe',
      }),
    ).toThrow(UnsafeEnvironmentError);
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

  it('未対応の検証方式を拒否する（UD-801 未決定のため dev のみ）', () => {
    const result = parseEnv(apiEnvSchema, {
      ...MINIMAL_API_ENV,
      AUTH_PROVIDER: 'supabase',
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
