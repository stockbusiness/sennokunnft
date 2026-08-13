import { ignores, nodeBase } from './eslint.base.mjs';

export default [
  ignores,
  ...nodeBase,
  {
    // config パッケージ自身は環境変数を読むことが責務なので、
    // process.env の参照制限は適用しない。
    files: ['src/**/*.ts', 'scripts/**/*.mjs', 'tests/**/*.ts'],
  },
];
