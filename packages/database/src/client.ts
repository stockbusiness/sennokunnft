/**
 * Prisma Client の生成。
 *
 * ⚠️ **モジュール読み込み時に接続を張らない。**
 * import しただけで DB へ繋がると、テストやビルドが外部依存を持ってしまう。
 * 接続は明示的に `createPrismaClient()` を呼んだときだけ行う。
 */

/**
 * 生成された Prisma Client の型。
 *
 * `import type` なので実行時には何も読み込まれない。
 * 型だけを借りることで、クエリの型安全性を得つつ、
 * 「import しただけで DB へ繋がる」ことを避けている。
 */
export type { PrismaClient } from '../generated/client';

/**
 * 本パッケージが必要とする Prisma Client の最小インターフェース。
 *
 * 生成物（`generated/client`）への依存を型の面で切り離しておくことで、
 * Client 未生成の状態でも他パッケージの型検査が通る。
 */
export interface PrismaClientLike {
  $connect(): Promise<void>;
  $disconnect(): Promise<void>;
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

export interface CreatePrismaClientOptions {
  readonly databaseUrl: string;
  /** クエリログを出すか。既定は無効（クエリには値が含まれるため）。 */
  readonly logQueries?: boolean;
}

/**
 * Prisma Client を生成する。
 *
 * 生成物は `prisma generate` を実行するまで存在しないため、動的に読み込む。
 * これにより、Client を生成していない環境でもこのモジュールを import できる。
 */
export async function createPrismaClient(
  options: CreatePrismaClientOptions,
): Promise<PrismaClientLike> {
  // 生成物は `prisma generate` を実行するまで存在しない。
  // 静的に解決させないよう、モジュール指定子を変数に入れている。
  // こうしておくと、Client 未生成の状態でも型検査とビルドが通る。
  const generatedModulePath = '../generated/client/index.js';
  const generated = (await import(generatedModulePath)) as {
    PrismaClient: new (config: unknown) => PrismaClientLike;
  };

  return new generated.PrismaClient({
    datasources: { db: { url: options.databaseUrl } },
    // クエリログには値（＝個人情報になりうる）が含まれるため、既定では出さない。
    log: options.logQueries === true ? ['query', 'warn', 'error'] : ['warn', 'error'],
  });
}

export interface DatabaseConnectionCheck {
  readonly ok: boolean;
  readonly durationMs: number;
}

/**
 * 接続確認。readiness プローブから使う。
 *
 * ⚠️ 失敗理由に接続文字列やホスト名を含めない。
 * ヘルスチェックは認証なしで到達できるため、内部構成の偵察に使われうる。
 */
export async function checkDatabaseConnection(
  client: PrismaClientLike,
  nowMs: () => number = () => Date.now(),
): Promise<DatabaseConnectionCheck> {
  const startedAt = nowMs();
  try {
    await client.$queryRawUnsafe('SELECT 1');
    return { ok: true, durationMs: nowMs() - startedAt };
  } catch {
    return { ok: false, durationMs: nowMs() - startedAt };
  }
}
