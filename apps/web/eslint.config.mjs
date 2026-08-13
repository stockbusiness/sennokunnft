import { ignores, nodeBase, noDirectProcessEnv } from '../../packages/config/eslint.base.mjs';

export default [
  ignores,
  { ignores: ['.next/**', 'next-env.d.ts'] },
  ...nodeBase,
  noDirectProcessEnv,
  {
    files: ['**/*.tsx'],
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
  },
  {
    files: ['src/env.ts', 'next.config.mjs', 'playwright.config.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
];
