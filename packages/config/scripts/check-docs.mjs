#!/usr/bin/env node
// @ts-check
/**
 * 未決定事項レジスタの整合性検査。
 *
 * 「未決定事項が文書に一覧化されている」ことは受入条件のひとつであり、
 * レジスタが実態とずれていると、そのまま「決めたつもり」の見落としになる。
 *
 * この検査は実際に起きたずれから追加した。
 * Phase 0 時点で件数を手で数えており、UD-xxx を追記するうちに
 * 記載件数（41件）と実際の行数（44件）が食い違っていた。
 * 人間が数え直す限り同じことが起きるので、機械に数えさせる。
 *
 * 検査するのは次の 3 点:
 *  1. どこかで参照されている UD-xxx が、レジスタに載っているか
 *  2. レジスタに ID の重複がないか
 *  3. 記載された合計件数と内訳が、実際の行数と一致しているか
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const docsDir = join(projectRoot, 'docs');
const registerPath = join(docsDir, 'IMPLEMENTATION_ROADMAP.md');

/** レジスタ以外に、UD-xxx を参照しうる場所。 */
const EXTRA_SOURCES = ['packages/database/prisma/schema.prisma', 'README.md'];

const UD_PATTERN = /UD-\d+/g;
/** レジスタの行。先頭セルが UD-xxx のものだけを数える。 */
const REGISTER_ROW = /^\|\s*(UD-\d+)\s*\|/;
const TOTAL_LINE =
  /\*\*合計:\s*(\d+)件（🔴\s*(\d+)件\s*\/\s*🟠\s*(\d+)件\s*\/\s*🟡\s*(\d+)件）\*\*/;

const violations = [];

if (!existsSync(registerPath)) {
  console.error('✗ docs/IMPLEMENTATION_ROADMAP.md が見つかりません。');
  process.exit(1);
}

const register = readFileSync(registerPath, 'utf8');
const registerLines = register.split('\n');

// --- レジスタの行を集める ---------------------------------------------------
const registeredIds = [];
const counts = { red: 0, orange: 0, yellow: 0 };

for (const line of registerLines) {
  const match = REGISTER_ROW.exec(line);
  if (match === null) continue;
  registeredIds.push(match[1]);
  if (line.includes('🔴')) counts.red += 1;
  else if (line.includes('🟠')) counts.orange += 1;
  else if (line.includes('🟡')) counts.yellow += 1;
  else violations.push(`[優先度なし] ${match[1]} に 🔴 / 🟠 / 🟡 のいずれも付いていません。`);
}

if (registeredIds.length === 0) {
  console.error(
    '✗ レジスタに UD-xxx の行が 1 件も見つかりませんでした。表の書式が変わった可能性があります。',
  );
  process.exit(1);
}

// --- 1. 重複 ----------------------------------------------------------------
const seen = new Set();
for (const id of registeredIds) {
  if (seen.has(id)) {
    violations.push(`[重複] ${id} がレジスタに複数回あります。`);
  }
  seen.add(id);
}

// --- 2. 参照されているのにレジスタに無い ID ---------------------------------
const sources = [
  ...readdirSync(docsDir)
    .filter((name) => name.endsWith('.md'))
    .map((name) => join(docsDir, name)),
  ...EXTRA_SOURCES.map((relative) => join(projectRoot, relative)),
].filter((path) => existsSync(path));

for (const path of sources) {
  const content = readFileSync(path, 'utf8');
  for (const id of content.match(UD_PATTERN) ?? []) {
    if (!seen.has(id)) {
      violations.push(
        `[未登録] ${id} が ${path.replace(`${projectRoot}/`, '')} で参照されていますが、レジスタにありません。`,
      );
    }
  }
}

// --- 3. 記載された合計と実際の行数 ------------------------------------------
const totalMatch = TOTAL_LINE.exec(register);
if (totalMatch === null) {
  violations.push(
    '[書式] レジスタに「**合計: N件（🔴 N件 / 🟠 N件 / 🟡 N件）**」の記載が見つかりません。',
  );
} else {
  const [, statedTotal, statedRed, statedOrange, statedYellow] = totalMatch;
  const expected = [
    ['合計', Number(statedTotal), registeredIds.length],
    ['🔴', Number(statedRed), counts.red],
    ['🟠', Number(statedOrange), counts.orange],
    ['🟡', Number(statedYellow), counts.yellow],
  ];
  for (const [label, stated, actual] of expected) {
    if (stated !== actual) {
      violations.push(
        `[件数不一致] ${label}: 記載 ${String(stated)} 件、実際 ${String(actual)} 件。`,
      );
    }
  }
}

if (violations.length > 0) {
  console.error('✗ 未決定事項レジスタの検査に失敗しました:\n');
  for (const violation of violations) console.error(`  ${violation}`);
  console.error('\nレジスタは docs/IMPLEMENTATION_ROADMAP.md「未決定事項レジスタ」です。');
  process.exit(1);
}

console.log(
  `✓ 未決定事項レジスタの検査に合格しました（${String(registeredIds.length)} 件、重複・未登録・件数不一致なし）。`,
);
