/* eslint-disable no-restricted-properties -- 下のコメントに理由を書いてある。 */

/**
 * 合言葉の門が読む設定（`UD-101` が決まるまでの暫定）。
 *
 * ⚠️ **ここだけ `process.env` を直接読む。**
 * 門は Next の middleware で働く。middleware は edge ランタイムで動き、
 * `loadEnv` は検証に失敗するとプロセスを終了させるため、そのまま通せない。
 * 「門の判定に必要な 2 つだけを、ここ 1 か所で読む」形にしてある。
 *
 * ⚠️ **読む変数を増やさない。** 増やすなら `@sengoku/config` の
 * `getWebEnv()` を使う。ここを窓口にすると、検証を通らない設定が
 * じわじわ増える。
 *
 * 変数そのものの説明と型は `webEnvSchema` にある。
 */

/** グループ内テストの合言葉。未設定なら公開環境では全拒否になる。 */
export function readGatePassword(): string | undefined {
  const value = process.env.SITE_GATE_PASSWORD;
  return value === undefined || value === '' ? undefined : value;
}

/**
 * Vercel が自動で入れる環境の名前。
 *
 * ⚠️ **こちらで設定しない。** 手で設定できるようにすると、
 * 「本番なのに development と名乗る」状態を作れてしまい、門の抜け道になる。
 */
export function readVercelEnv(): 'production' | 'preview' | 'development' | undefined {
  const value = process.env.VERCEL_ENV;
  return value === 'production' || value === 'preview' || value === 'development'
    ? value
    : undefined;
}
