import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // 結合テストは実 PostgreSQL に同じテーブルを使うため、直列に実行する。
    // 並列にすると TRUNCATE が他のテストの前提を壊す。
    fileParallelism: false,
    /*
      ⚠️ **既定の 10 秒では足りない。** 各テストの前に走る `resetDatabase`
         は 40 近い表を TRUNCATE して基準データを戻す。単体では 1 回
         数十 ms でも、`pnpm verify` で他のタスクと CPU を取り合うと
         2 倍以上に伸びる。10 秒を越えた 1 回が落ちると、そのあとの
         テストは掃除されていない DB を相手にして**別の理由で落ちる**
         ——原因がタイムアウトだと気づきにくい落ち方をする。
    */
    hookTimeout: 60_000,
  },
});
