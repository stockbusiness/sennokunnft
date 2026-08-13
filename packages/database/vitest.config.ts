import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // 結合テストは実 PostgreSQL に同じテーブルを使うため、直列に実行する。
    // 並列にすると TRUNCATE が他のテストの前提を壊す。
    fileParallelism: false,
  },
});
