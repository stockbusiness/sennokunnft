import { ignores, nodeBase, noDirectProcessEnv } from '../../packages/config/eslint.base.mjs';

export default [
  ignores,
  ...nodeBase,
  noDirectProcessEnv,
  {
    // 起動処理は環境変数と起動引数を読み込むことが責務。
    files: ['src/main.ts', 'src/staging-fixture-cli.ts', 'src/wallet-resend-cli.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
  {
    // 結合テストのハーネスは、接続先を環境変数から受け取ることが責務。
    // アプリ本体と違い、検証済み設定オブジェクトを経由させる意味がないので
    // ここだけ制限を外す（本体コードには引き続き適用される）。
    files: ['tests/**/*.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
];
