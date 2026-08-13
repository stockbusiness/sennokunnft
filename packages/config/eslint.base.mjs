// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

/**
 * リポジトリ共通の ESLint 設定。
 *
 * ここでのルールは「好みの統一」ではなく、
 * **設計上の禁止事項をコードで守らせる**ことを目的にしたものを中心に置いている。
 */
export const ignores = {
  ignores: [
    '**/dist/**',
    '**/.next/**',
    '**/coverage/**',
    '**/generated/**',
    '**/node_modules/**',
    '**/.turbo/**',
    '**/playwright-report/**',
    '**/test-results/**',
  ],
};

/** Node 環境で動くパッケージ向けの基本設定。 */
export const nodeBase = tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // 未使用変数は `_` 接頭辞で明示的に許可する。
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // `any` は型の穴になるため、明示的な理由なしに使わせない。
      '@typescript-eslint/no-explicit-any': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-restricted-syntax': [
        'error',
        {
          // SECURITY_DESIGN.md §8: Claim トークン等の生成に Math.random を使わせない。
          selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
          message:
            'Math.random() は暗号学的に安全でない。乱数が必要な場合は crypto.randomBytes か IdGeneratorPort を使うこと。',
        },
      ],
    },
  },
  prettier,
);

/**
 * `process.env` の直接参照を禁止する設定。
 *
 * 環境変数は必ず `@sengoku/config` の検証済みオブジェクト経由で読む。
 * 直接参照を許すと、検証されていない値が実行時に紛れ込み、
 * 「起動はしたが設定が欠けている」状態を作ってしまう。
 *
 * 環境変数を読むこと自体が責務である箇所（起動処理・config パッケージ自身）は
 * 個別に無効化する。
 */
export const noDirectProcessEnv = {
  rules: {
    'no-restricted-properties': [
      'error',
      {
        object: 'process',
        property: 'env',
        message:
          'process.env を直接参照しない。@sengoku/config の loadEnv で検証したオブジェクトを使うこと。',
      },
    ],
  },
};

/** 型情報を必要としない軽量な設定のみを使う（typecheck は tsc が担当する）。 */
export default { ignores, nodeBase, noDirectProcessEnv };
