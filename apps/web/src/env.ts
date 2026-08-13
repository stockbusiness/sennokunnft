import { loadEnv, webEnvSchema, type WebEnv } from '@sengoku/config';

/**
 * web プロセスの環境変数。
 *
 * ⚠️ **サーバー側でのみ読むこと。**
 * `NEXT_PUBLIC_` 接頭辞のない値はブラウザへ送られない前提で扱う。
 * 逆に `NEXT_PUBLIC_` の値はバンドルに埋め込まれるため、秘密にできない。
 *
 * 検証は遅延評価にしてある。モジュール読み込み時に実行すると、
 * ビルド時（環境変数が未設定でありうる場面）に失敗してしまうため。
 */
let cached: WebEnv | undefined;

export function getWebEnv(): WebEnv {
  cached ??= loadEnv(webEnvSchema);
  return cached;
}
