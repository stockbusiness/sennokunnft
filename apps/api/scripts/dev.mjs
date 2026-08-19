#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 手元で api を走らせる。
 *
 * ⚠️ **`tsx` を使わない。** esbuild 系の変換器は
 * `emitDecoratorMetadata` を出力しないため、Nest が依存を解決できず、
 * **起動には成功したまま全エンドポイントが 500 を返す**。
 * 詳しくは `src/common/decorator-metadata.ts`。
 *
 * ⚠️ **本番ビルドと同じ `tsc` を使う。** dev と build で別のコンパイラを
 * 使うと、「手元では動くのに配備すると壊れる」（あるいはその逆）が起きる。
 * 同じものを通しておけば、その食い違い自体が起こらない。
 *
 * やっていること:
 *   1. `tsc --watch` で `dist` を作り続ける
 *   2. 最初の出力ができてから `node --watch dist/main.js` を起動する
 *   3. どちらかが終わったら、もう一方も終わらせる
 */

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const entry = resolve(appDir, 'dist/main.js');

/** 最初のビルドを待つ間隔と、諦めるまでの時間。 */
const POLL_INTERVAL_MS = 200;
const FIRST_BUILD_TIMEOUT_MS = 120_000;

const children = [];
let shuttingDown = false;

/**
 * 全部まとめて終わらせる。
 *
 * ⚠️ **片方だけ残さない。** `tsc --watch` が生き残ると、次に起動したとき
 * 2 つの監視が同じ `dist` を書き、原因のわからない再起動が続く。
 */
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
    }
  }
  process.exit(code);
}

function run(command, args) {
  const child = spawn(command, args, { cwd: appDir, stdio: 'inherit', shell: false });
  children.push(child);
  child.on('exit', (exitCode, signal) => {
    // 片方が落ちたら、もう片方を残さない。
    shutdown(signal === null ? (exitCode ?? 0) : 1);
  });
  child.on('error', (error) => {
    console.error(`起動できませんでした: ${command}\n${String(error)}`);
    shutdown(1);
  });
  return child;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shutdown(0);
  });
}

// 1. 型検査つきのビルドを回し続ける。
//    ⚠️ `--preserveWatchOutput` を付ける。付けないと tsc が画面を消し、
//       node 側のログ（起動の失敗を含む）が読めなくなる。
run('node', [
  resolve(appDir, '../../node_modules/typescript/bin/tsc'),
  '-p',
  'tsconfig.build.json',
  '--watch',
  '--preserveWatchOutput',
]);

// 2. 最初の出力ができるまで待つ。
//    ⚠️ 待たずに起動すると、`dist/main.js` がまだ無くて node が即死する。
const startedAt = Date.now();
console.log('最初のビルドを待っています…');
const waiting = setInterval(() => {
  if (existsSync(entry)) {
    clearInterval(waiting);
    run('node', ['--watch', '--watch-preserve-output', entry]);
    return;
  }
  if (Date.now() - startedAt > FIRST_BUILD_TIMEOUT_MS) {
    clearInterval(waiting);
    console.error(
      'ビルドが終わらないため、起動を諦めました。上の tsc の出力に型エラーが出ていないか確かめてください。',
    );
    shutdown(1);
  }
}, POLL_INTERVAL_MS);
