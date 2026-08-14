import {
  assertCommonUserLinkingConfig,
  assertPhaseOneIntegrationLimits,
  assertProductionSafety,
  loadEnv,
  UnsafeEnvironmentError,
  workerEnvSchema,
} from '@sengoku/config';
import {
  createPrismaClient,
  PrismaCommonUserLinkRepository,
  type PrismaClient,
} from '@sengoku/database';
import { AgencyCommonUserDirectory, SystemClock } from '@sengoku/integrations';
import { createLogger } from '@sengoku/observability';
import { createCommonUserLinkJob } from './common-user-job';
import { WorkerRunner, type JobHandler } from './runner';

/**
 * Worker プロセスの起動。
 *
 * 2 つのモードを持つ:
 *  - 既定: 常駐してポーリングし続ける
 *  - `--once`: 1 巡だけ処理して終了する（cron 起動の環境向け）
 *
 * デプロイ先が常駐プロセスを許すかは未決定（UD-302）のため、
 * どちらの運用形態でも動くようにしてある。
 */
async function bootstrap(): Promise<void> {
  const runOnceMode = process.argv.includes('--once');

  // 環境変数の検証。不足していればここで異常終了する。
  const env = loadEnv(workerEnvSchema);
  const logger = createLogger({ service: 'worker', level: env.LOG_LEVEL });

  try {
    assertPhaseOneIntegrationLimits(env);
    assertProductionSafety(env);
    // 有効なのに接続先や鍵が無い状態で起動させない。
    // 起動すると全件が PENDING に積み上がるが、購入は続くので誰も気付かない。
    assertCommonUserLinkingConfig(env);
  } catch (error) {
    if (error instanceof UnsafeEnvironmentError) {
      logger.fatal({ reasons: error.reasons }, '環境設定が安全でないため起動を中止しました');
      process.exit(1);
    }
    throw error;
  }

  const handlers: JobHandler[] = [];

  // 共通顧客IDの解決。⚠️ 既定は無効（指示書 §16）。
  // フラグが立っていなければ、ハンドラそのものを登録しない。
  // 「登録はするが中で何もしない」にすると、無効なのに毎回 DB を引く。
  if (env.COMMON_USER_LINKING_ENABLED) {
    const prisma = (await createPrismaClient({ databaseUrl: env.DATABASE_URL })) as PrismaClient;
    handlers.push(
      createCommonUserLinkJob({
        logger,
        batchSize: env.COMMON_USER_LINK_BATCH_SIZE,
        deps: {
          links: new PrismaCommonUserLinkRepository(prisma),
          directory: new AgencyCommonUserDirectory({
            // 上のガードで存在を確認済み。
            baseUrl: env.COMMON_USER_API_BASE_URL ?? '',
            apiKey: env.COMMON_USER_API_KEY ?? '',
            systemKey: env.COMMON_USER_SYSTEM_KEY,
          }),
          clock: new SystemClock(),
          systemKey: env.COMMON_USER_SYSTEM_KEY,
        },
      }),
    );
    logger.info({ batchSize: env.COMMON_USER_LINK_BATCH_SIZE }, '共通顧客ID連携を有効化しました');
  }

  // 発行ジョブ・Outbox 配信・期限切れ回収は Phase 5-6 で追加する。

  const runner = new WorkerRunner({
    handlers,
    logger,
    pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
  });

  const shutdown = (signal: string): void => {
    logger.info({ signal }, '停止要求を受け付けました。処理中のジョブの完了を待ちます');
    runner.requestStop();
  };
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });

  if (runOnceMode) {
    const result = await runner.runOnce();
    logger.info(
      { mode: 'once', processed: result.processed, failures: result.failures },
      'worker finished',
    );
    // ハンドラが失敗していたら異常終了させ、cron の失敗として検知できるようにする。
    process.exit(result.failures > 0 ? 1 : 0);
  }

  await runner.runForever();
}

void bootstrap();
