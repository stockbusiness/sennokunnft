import type { EnvIntegrationSummary, IntegrationService } from '@sengoku/domain';

/**
 * 配備環境（環境変数）から読める、その連携の姿（指示書 §4・§11）。
 *
 * ⚠️ **値を返さない。** 返すのは「どの方式か」「そろっているか」
 * 「何という名前の設定が欠けているか」まで。設定の**名前**は秘密ではなく、
 * 直すために要る。値は秘密でありうるので、一切持ち出さない。
 *
 * ⚠️ **`publicUrl` は公開してよい URL だけ。** 画像の配信元と鍵束の置き場は
 * ブラウザからも見える。資格情報を含む URL をここへ入れない。
 *
 * ⚠️ **起動時のガード（`assertMediaStorageConfig` 等）と同じ項目を見る。**
 * 別々に並べると、片方だけ直したときに「画面ではそろっているのに起動しない」
 * が生まれる。ここは表示のためだけの写しであり、判定の正はガードのほう。
 */
export interface IntegrationEnvironmentInput {
  readonly MEDIA_STORAGE_PROVIDER: string;
  readonly MEDIA_PUBLIC_BASE_URL?: string;
  readonly R2_ACCOUNT_ID?: string;
  readonly R2_BUCKET?: string;
  readonly R2_ACCESS_KEY_ID?: string;
  readonly R2_SECRET_ACCESS_KEY?: string;
  readonly AUTH_PROVIDER: string;
  readonly SUPABASE_JWT_ISSUER?: string;
  readonly SUPABASE_JWT_AUDIENCE?: string;
  readonly SUPABASE_JWKS_URL?: string;
  /** メールの送信（P0-7 の 6 番目）。⚠️ 鍵の値は持ち出さない。 */
  readonly MAIL_PROVIDER?: string;
  readonly RESEND_API_KEY?: string;
  readonly MAIL_FROM_ADDRESS?: string;
}

export function describeIntegrationEnvironment(
  env: IntegrationEnvironmentInput,
): (service: IntegrationService) => EnvIntegrationSummary {
  return (service) => {
    switch (service) {
      case 'storage':
        return describeStorage(env);
      case 'auth':
        return describeAuth(env);
      case 'mail':
        return describeMail(env);
      case 'payment':
      case 'ovew_wallet':
        /*
          ⚠️ 決済と Wallet は管理画面が正なので、ここは呼ばれない。
             それでも値を返せるようにしておくのは、呼ばれたときに
             例外で 500 になるより、空の姿を返すほうが調べやすいため。
        */
        return { provider: 'database', complete: false, missing: [], publicUrl: null };
    }
  };
}

function describeStorage(env: IntegrationEnvironmentInput): EnvIntegrationSummary {
  if (env.MEDIA_STORAGE_PROVIDER !== 'r2') {
    // 手元のファイル保存。配ることも確かめることもできない。
    return {
      provider: env.MEDIA_STORAGE_PROVIDER,
      complete: true,
      missing: [],
      publicUrl: null,
    };
  }

  const missing = missingNames([
    ['MEDIA_PUBLIC_BASE_URL', env.MEDIA_PUBLIC_BASE_URL],
    ['R2_ACCOUNT_ID', env.R2_ACCOUNT_ID],
    ['R2_BUCKET', env.R2_BUCKET],
    ['R2_ACCESS_KEY_ID', env.R2_ACCESS_KEY_ID],
    ['R2_SECRET_ACCESS_KEY', env.R2_SECRET_ACCESS_KEY],
  ]);

  return {
    provider: 'r2',
    complete: missing.length === 0,
    missing,
    // 画像の配信元。ブラウザから見えるものなので、出してよい。
    publicUrl: nonEmpty(env.MEDIA_PUBLIC_BASE_URL),
  };
}

function describeAuth(env: IntegrationEnvironmentInput): EnvIntegrationSummary {
  if (env.AUTH_PROVIDER !== 'supabase') {
    return { provider: env.AUTH_PROVIDER, complete: true, missing: [], publicUrl: null };
  }

  const missing = missingNames([
    ['SUPABASE_JWT_ISSUER', env.SUPABASE_JWT_ISSUER],
    ['SUPABASE_JWT_AUDIENCE', env.SUPABASE_JWT_AUDIENCE],
    ['SUPABASE_JWKS_URL', env.SUPABASE_JWKS_URL],
  ]);

  return {
    provider: 'supabase',
    complete: missing.length === 0,
    missing,
    // 公開鍵の置き場。誰でも取りに行ける URL なので、出してよい。
    publicUrl: nonEmpty(env.SUPABASE_JWKS_URL),
  };
}

function missingNames(entries: readonly (readonly [string, string | undefined])[]): string[] {
  return entries.filter(([, value]) => nonEmpty(value) === null).map(([name]) => name);
}

function nonEmpty(value: string | undefined): string | null {
  return value === undefined || value === '' ? null : value;
}

/**
 * メールの送信（P0-7 の 6 番目）。
 *
 * ⚠️ **`publicUrl` を返さない。** 到達性の確認（`OPTIONS`）を
 * 走らせないため。メールで確かめたいのは「届くホストがあるか」では
 * なく「この鍵で受け付けられるか」で、それは試し送りでしか分からない。
 *
 * ⚠️ **差出人アドレスを返さない。** 秘密ではないが、ここは値を返さない
 * 場所と決めてある。返す場所を 1 つ作ると、次は鍵が載る。
 */
function describeMail(env: IntegrationEnvironmentInput): EnvIntegrationSummary {
  const provider = env.MAIL_PROVIDER ?? 'none';
  if (provider !== 'resend') {
    // 送らない配備。⚠️ **「そろっている」と言わない。** 送れないのだから。
    return { provider, complete: false, missing: ['MAIL_PROVIDER'], publicUrl: null };
  }

  const missing = missingNames([
    ['RESEND_API_KEY', env.RESEND_API_KEY],
    ['MAIL_FROM_ADDRESS', env.MAIL_FROM_ADDRESS],
  ]);

  return { provider: 'resend', complete: missing.length === 0, missing, publicUrl: null };
}
