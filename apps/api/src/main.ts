import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import {
  apiEnvSchema,
  assertPhaseOneIntegrationLimits,
  assertProductionSafety,
  loadEnv,
  UnsafeEnvironmentError,
} from '@sengoku/config';
import { createLogger } from '@sengoku/observability';
import {
  checkDatabaseConnection,
  createPrismaClient,
  PrismaAccountRepository,
  PrismaArtworkRepository,
  PrismaAuditLogRepository,
  PrismaListingRepository,
  PrismaIdempotencyStore,
  type PrismaClient,
} from '@sengoku/database';
import {
  DevTokenVerifier,
  LocalFileStorage,
  SystemClock,
  UuidGenerator,
  generateStorageKey,
} from '@sengoku/integrations';
import { AppModule } from './app.module';
import { DomainErrorFilter } from './common/domain-error.filter';
import { NestStructuredLogger } from './common/nest-logger';
import type { DependencyProbe } from './health/health.service';

const VERSION = '0.1.0';

/**
 * API プロセスの起動。
 *
 * 起動順序に意味がある:
 *  1. 環境変数を検証する（不足していれば**この時点で異常終了**する）
 *  2. 設定の組み合わせが安全かを検査する
 *  3. アプリケーションを組み立てる
 *
 * 「起動はしたが設定が欠けていて一部機能が壊れている」状態を作らないため、
 * 検証を通過するまでサーバーを立ち上げない。
 */
async function bootstrap(): Promise<void> {
  // 1. 環境変数の検証。失敗時は変数名のみを出力してプロセスを終了する。
  const env = loadEnv(apiEnvSchema);

  const logger = createLogger({ service: 'api', level: env.LOG_LEVEL });

  // 2. 設定の組み合わせ検査。
  try {
    assertPhaseOneIntegrationLimits(env);
    assertProductionSafety(env);
  } catch (error) {
    if (error instanceof UnsafeEnvironmentError) {
      // 理由は変数名と説明のみで、値を含まない。
      logger.fatal({ reasons: error.reasons }, '環境設定が安全でないため起動を中止しました');
      process.exit(1);
    }
    throw error;
  }

  // 3. DB 接続。ここで初めて外部へ繋ぐ。
  const prisma = (await createPrismaClient({ databaseUrl: env.DATABASE_URL })) as PrismaClient;

  const probes: DependencyProbe[] = [
    {
      name: 'database',
      check: () => checkDatabaseConnection(prisma),
    },
  ];

  // 4. トークン検証。
  //    検証方式が未決定（UD-801）のため開発用実装のみ。
  //    本番で dev を使えないことは assertProductionSafety が保証している。
  if (env.AUTH_DEV_SECRET === undefined) {
    logger.fatal(
      { variable: 'AUTH_DEV_SECRET' },
      '認証に必要な環境変数が設定されていないため起動を中止しました',
    );
    process.exit(1);
  }
  const tokenVerifier = new DevTokenVerifier({
    secret: env.AUTH_DEV_SECRET,
    issuer: env.SUPABASE_JWT_ISSUER ?? 'sennokunnft-dev',
    audience: env.SUPABASE_JWT_AUDIENCE ?? 'sennokunnft',
  });

  const app = await NestFactory.create(
    AppModule.register({
      version: VERSION,
      probes,
      artworks: new PrismaArtworkRepository(prisma),
      listings: new PrismaListingRepository(prisma),
      accounts: new PrismaAccountRepository(prisma),
      // ⚠️ 冪等キーは DB に置く。プロセス内メモリだと台数を増やした瞬間に効かなくなる。
      idempotency: new PrismaIdempotencyStore(prisma),
      tokenVerifier,
      clock: new SystemClock(),
      ids: new UuidGenerator(),
      // ✅ 本番ストレージへは接続しない。保存先は UD-508 で未決定。
      storage: new LocalFileStorage(env.MEDIA_STORAGE_DIR, env.MEDIA_PUBLIC_PREFIX),
      audit: new PrismaAuditLogRepository(prisma),
      generateStorageKey,
    }),
    // Webhook の署名検証には**パース前の生の本文**が必要になる（Phase 3）。
    // 後から有効化すると取りこぼしに気付きにくいため、最初から有効にしておく。
    { rawBody: true, bufferLogs: true },
  );

  // フレームワークのログも同じ経路へ流す。マスキングを素通りする出口を作らない。
  app.useLogger(new NestStructuredLogger(logger));
  app.useGlobalFilters(new DomainErrorFilter());

  // CORS の許可オリジンは環境変数から与える。ワイルドカードを使わない。
  app.enableCors({ origin: [env.API_PUBLIC_ORIGIN], credentials: true });

  await app.listen(env.API_PORT);
  logger.info({ port: env.API_PORT, appEnv: env.APP_ENV, version: VERSION }, 'api started');

  // シグナル処理は自前で行い、NestJS の enableShutdownHooks() は使わない。
  // 併用すると両方が close を走らせ、終了コードが不定になる
  // （Nest 側は後始末のあとシグナルを再送するため 143 で終わる）。
  // 停止が正常終了だったかをオーケストレータが判定できるよう、0 で終える。
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    // close() は処理中のリクエストを完了させてから解決する。
    // DB 接続はその後に閉じる（処理中のクエリを切らないため）。
    void app
      .close()
      .then(() => prisma.$disconnect())
      .then(
        () => {
          process.exit(0);
        },
        (error: unknown) => {
          logger.error(
            { error: error instanceof Error ? error.name : 'UnknownError' },
            '停止処理に失敗しました',
          );
          process.exit(1);
        },
      );
  };

  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
}

void bootstrap();
