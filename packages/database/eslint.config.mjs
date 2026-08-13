import { ignores, nodeBase, noDirectProcessEnv } from '../config/eslint.base.mjs';

export default [
  ignores,
  ...nodeBase,
  noDirectProcessEnv,
  {
    // 結合テストのハーネスは、接続先を環境変数から受け取ることが責務。
    // アプリ本体と違い、検証済み設定オブジェクトを経由させる意味がないので
    // ここだけ制限を外す（本体コードには引き続き適用される）。
    files: ['tests/**/*.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
];
