import { ignores, nodeBase, noDirectProcessEnv } from '../../packages/config/eslint.base.mjs';

export default [
  ignores,
  ...nodeBase,
  noDirectProcessEnv,
  {
    // 起動処理は環境変数と起動引数を読み込むことが責務。
    files: ['src/main.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
];
