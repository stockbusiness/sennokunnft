import { ignores, nodeBase, noDirectProcessEnv } from '../../packages/config/eslint.base.mjs';

export default [
  ignores,
  ...nodeBase,
  noDirectProcessEnv,
  {
    // 起動処理は環境変数を読み込むことが責務なので、参照制限を外す。
    files: ['src/main.ts', 'src/config.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
];
