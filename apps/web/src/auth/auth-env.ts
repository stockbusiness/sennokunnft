/* eslint-disable no-restricted-properties -- 下のコメントに理由を書いてある。 */

/**
 * middleware（edge）から読む設定。
 *
 * ⚠️ **ここだけ `process.env` を直接読む。**
 * middleware は edge ランタイムで動き、`loadEnv` は検証に失敗すると
 * プロセスを終了させるため、そのまま通せない。`gate-env.ts` と同じ理由。
 *
 * ⚠️ **読む変数を増やさない。** 画面や経路からは `getWebEnv()` を使う。
 * ここを窓口にすると、検証を通らない設定がじわじわ増える。
 *
 * 変数そのものの説明と型は `webEnvSchema` にある。
 */
function read(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

export function readSupabaseUrl(): string | undefined {
  return read('SUPABASE_URL');
}

export function readSupabaseAnonKey(): string | undefined {
  return read('SUPABASE_ANON_KEY');
}

/** ログイン機能が使える構成になっているか。 */
export function loginEnabled(): boolean {
  return readSupabaseUrl() !== undefined && readSupabaseAnonKey() !== undefined;
}
