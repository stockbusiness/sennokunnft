import {
  assertPhaseOneIntegrationLimits,
  assertProductionSafety,
  loadEnv,
  UnsafeEnvironmentError,
  workerEnvSchema,
} from '@sengoku/config';
import { createLogger } from '@sengoku/observability';
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
  } catch (error) {
    if (error instanceof UnsafeEnvironmentError) {
      logger.fatal({ reasons: error.reasons }, '環境設定が安全でないため起動を中止しました');
      process.exit(1);
    }
    throw error;
  }

  // Phase 1 ではジョブハンドラを登録しない。
  // 実際の処理（発行ジョブ・Outbox 配信・期限切れ回収）は Phase 5-6 で追加する。
  // ここで空のまま起動できることが、器としての最小要件。
  const handlers: JobHandler[] = [];

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
