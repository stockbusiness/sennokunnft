#!/usr/bin/env node
// @ts-check
/**
 * 秘密情報の混入検査。
 *
 * 検査するのは次の 4 点:
 *  1. `.env` 系ファイルが追跡対象に含まれていないか
 *  2. アップロードされた画像の保存先が追跡対象に含まれていないか
 *  3. `.env.example` に「値」が書かれていないか（変数名と説明のみが許される）
 *  4. ソース中に秘密情報らしき代入が直書きされていないか
 *
 * これは本格的な秘密スキャナの代替ではない（ツール選定は UD-901 で未決定）。
 * ここでは「このリポジトリで最も起きやすい混入経路」だけを塞ぐ。
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** git が追跡しているファイル一覧をプロジェクト相対で得る。 */
function listTrackedFiles() {
  try {
    const output = execFileSync('git', ['ls-files', '-z', '--', '.'], {
      cwd: projectRoot,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    return output.split('\0').filter((line) => line.length > 0);
  } catch {
    console.warn('! git のファイル一覧を取得できませんでした。追跡ファイルの検査を省略します。');
    return null;
  }
}

const violations = [];

/**
 * アップロードされた画像の保存先（`MEDIA_STORAGE_DIR`）。
 *
 * ⚠️ **利用者が送ったデータをリポジトリへ入れない。**
 * `.gitignore` へ書くだけでは、設定を足し忘れた保存先が素通りする。
 * 実際に E2E が保存した画像を一度取り込んでしまったため、検査で止める。
 */
const MEDIA_DIRS = ['.media', '.e2e-media'];

// --- 1〜2. .env 系・鍵・アップロード物の混入 ----------------------------------
const tracked = listTrackedFiles();
if (tracked !== null) {
  for (const file of tracked) {
    const basename = file.split('/').pop() ?? '';
    if (basename === '.env.example') continue;
    if (basename === '.env' || basename.startsWith('.env.')) {
      violations.push(
        `[env混入] ${file} が追跡されています。.env 系は .env.example 以外コミットしないこと。`,
      );
    }
    if (/\.(pem|key|p12|keystore)$/.test(basename)) {
      violations.push(`[鍵混入] ${file} が追跡されています。鍵ファイルをコミットしないこと。`);
    }
    if (file.split('/').some((segment) => MEDIA_DIRS.includes(segment))) {
      violations.push(
        `[アップロード物混入] ${file} が追跡されています。保存された画像をコミットしないこと。`,
      );
    }
  }
}

// --- 3. .env.example に値が書かれていないか -----------------------------------
const examplePath = join(projectRoot, '.env.example');
if (!existsSync(examplePath)) {
  violations.push('[不足] .env.example が存在しません。必要な環境変数を文書化すること。');
} else {
  const lines = readFileSync(examplePath, 'utf8').split('\n');
  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) return;
    const separator = line.indexOf('=');
    if (separator === -1) {
      violations.push(`[書式] .env.example:${String(index + 1)} は KEY= の形式ではありません。`);
      return;
    }
    const value = line.slice(separator + 1).trim();
    if (value !== '') {
      const key = line.slice(0, separator);
      // 値そのものは出力しない。出力すると検査ログに秘密が載る。
      violations.push(
        `[値記入] .env.example:${String(index + 1)} の ${key} に値が書かれています。変数名と説明のみにすること。`,
      );
    }
  });
}

// --- 4. ソース中の直書き秘密 --------------------------------------------------
const SECRET_PATTERNS = [
  { name: 'AWS アクセスキー', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub トークン', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'Stripe 秘密鍵', re: /\bsk_(live|test)_[A-Za-z0-9]{16,}\b/ },
  {
    name: 'JSON Web Token',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
  { name: '秘密鍵ブロック', re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'EVM 秘密鍵らしき値', re: /\b0x[a-fA-F0-9]{64}\b/ },
];

const SCANNABLE = /\.(ts|tsx|js|jsx|mjs|cjs|json|ya?ml|env|sql|prisma|md)$/;
const SKIP_PATHS = [
  'pnpm-lock.yaml',
  'packages/config/scripts/check-secrets.mjs', // 検出パターン自体を含むため
];

if (tracked !== null) {
  for (const file of tracked) {
    if (!SCANNABLE.test(file)) continue;
    if (SKIP_PATHS.some((skip) => file === skip || file.endsWith(`/${skip}`))) continue;
    const absolute = join(projectRoot, file);
    if (!existsSync(absolute)) continue;
    const content = readFileSync(absolute, 'utf8');
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.re.test(content)) {
        // 一致した値は出力しない。
        violations.push(
          `[直書き] ${relative(projectRoot, absolute)} に ${pattern.name} らしき文字列があります。`,
        );
      }
    }
  }
}

if (violations.length > 0) {
  console.error('✗ 秘密情報の検査に失敗しました:\n');
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}

console.log(
  '✓ 秘密情報の検査に合格しました（.env 混入なし / .env.example に値なし / 直書きなし）。',
);
