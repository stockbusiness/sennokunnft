#!/usr/bin/env node
// @ts-check
/**
 * 依存グラフ検査。
 *
 * 2 種類の違反を検出する:
 *  1. **循環依存** — A → B → A のような閉路
 *  2. **層越え依存** — 循環はしていないが、アーキテクチャ上許されない向きの依存
 *     （例: `ui` → `database`、`domain` → NestJS）
 *
 * 1 だけを検査しても「循環はないが層が壊れている」状態は見逃す。
 * ARCHITECTURE.md §3-4 の依存表をここに写し、機械的に守らせる。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * 各ワークスペースが依存してよいワークスペースの許可リスト。
 * ここに無い依存はすべて違反とする（既定 deny）。
 */
const ALLOWED = {
  '@sengoku/config': [],
  '@sengoku/validation': [],
  '@sengoku/ui': [],
  '@sengoku/observability': ['@sengoku/config'],
  '@sengoku/domain': ['@sengoku/validation'],
  '@sengoku/contracts': ['@sengoku/validation', '@sengoku/domain'],
  '@sengoku/database': ['@sengoku/auth', '@sengoku/config', '@sengoku/domain'],
  '@sengoku/auth': ['@sengoku/config', '@sengoku/domain'],
  '@sengoku/integrations': [
    '@sengoku/auth',
    '@sengoku/config',
    '@sengoku/domain',
    '@sengoku/observability',
  ],
  '@sengoku/web': [
    '@sengoku/config',
    '@sengoku/contracts',
    '@sengoku/observability',
    '@sengoku/ui',
    '@sengoku/validation',
  ],
  '@sengoku/api': [
    '@sengoku/auth',
    '@sengoku/config',
    '@sengoku/contracts',
    '@sengoku/database',
    '@sengoku/domain',
    '@sengoku/integrations',
    '@sengoku/observability',
    '@sengoku/validation',
  ],
  '@sengoku/worker': [
    '@sengoku/config',
    '@sengoku/contracts',
    '@sengoku/database',
    '@sengoku/domain',
    '@sengoku/integrations',
    '@sengoku/observability',
  ],
};

/**
 * ドメイン層に持ち込ませない依存。
 * ビジネスロジックがフレームワーク層へ混在することを防ぐ（ロールバック条件 #4）。
 */
const FORBIDDEN_EXTERNAL = {
  '@sengoku/domain': ['@nestjs/', 'next', 'react', '@prisma/client', 'prisma', 'express', 'pino'],
  '@sengoku/validation': ['@nestjs/', 'next', 'react', '@prisma/client', 'express'],
  '@sengoku/ui': ['@nestjs/', '@prisma/client', 'express', 'pino'],
  '@sengoku/contracts': ['@nestjs/', 'next', 'react', '@prisma/client', 'express'],
};

/** ワークスペースの package.json をすべて読み込む。 */
function collectWorkspaces() {
  const workspaces = new Map();
  for (const group of ['apps', 'packages']) {
    const groupDir = join(repoRoot, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(groupDir, entry.name, 'package.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      workspaces.set(manifest.name, {
        name: manifest.name,
        dir: `${group}/${entry.name}`,
        dependencies: {
          ...(manifest.dependencies ?? {}),
          ...(manifest.peerDependencies ?? {}),
        },
        devDependencies: manifest.devDependencies ?? {},
      });
    }
  }
  return workspaces;
}

/** 有向グラフから閉路をすべて探す（DFS）。 */
function findCycles(graph) {
  const cycles = [];
  const state = new Map();
  const stack = [];

  function visit(node) {
    state.set(node, 'visiting');
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      if (!graph.has(next)) continue;
      const nextState = state.get(next);
      if (nextState === 'visiting') {
        const start = stack.indexOf(next);
        cycles.push([...stack.slice(start), next]);
      } else if (nextState === undefined) {
        visit(next);
      }
    }
    stack.pop();
    state.set(node, 'done');
  }

  for (const node of graph.keys()) {
    if (state.get(node) === undefined) visit(node);
  }
  return cycles;
}

function main() {
  const workspaces = collectWorkspaces();
  const violations = [];

  if (workspaces.size === 0) {
    console.error('✗ ワークスペースが1つも見つかりませんでした。');
    process.exit(1);
  }

  // --- 1. 許可されていないワークスペース間依存 ---------------------------------
  const graph = new Map();
  for (const [name, ws] of workspaces) {
    const internalDeps = Object.keys(ws.dependencies).filter((dep) => workspaces.has(dep));
    graph.set(name, internalDeps);

    const allowed = ALLOWED[name];
    if (allowed === undefined) {
      violations.push(`[未登録] ${name} が check-deps.mjs の ALLOWED に登録されていません。`);
      continue;
    }
    for (const dep of internalDeps) {
      if (!allowed.includes(dep)) {
        violations.push(
          `[層越え] ${name} → ${dep} は許可されていません（${ws.dir}/package.json）。`,
        );
      }
    }
  }

  // --- 2. 循環依存 -------------------------------------------------------------
  for (const cycle of findCycles(graph)) {
    violations.push(`[循環] ${cycle.join(' → ')}`);
  }

  // --- 3. 特定パッケージへ持ち込み禁止の外部依存 --------------------------------
  for (const [name, forbiddenPrefixes] of Object.entries(FORBIDDEN_EXTERNAL)) {
    const ws = workspaces.get(name);
    if (ws === undefined) continue;
    for (const dep of Object.keys(ws.dependencies)) {
      for (const prefix of forbiddenPrefixes) {
        if (dep === prefix || dep.startsWith(prefix)) {
          violations.push(
            `[混在] ${name} が ${dep} に依存しています。この層はフレームワーク非依存でなければなりません。`,
          );
        }
      }
    }
  }

  if (violations.length > 0) {
    console.error('✗ 依存グラフ検査に失敗しました:\n');
    for (const violation of violations) console.error(`  ${violation}`);
    console.error('\n許可される依存の向きは docs/ARCHITECTURE.md §3-4 を参照してください。');
    process.exit(1);
  }

  console.log(
    `✓ 依存グラフ検査に合格しました（${String(workspaces.size)} ワークスペース、循環なし）。`,
  );
}

main();
