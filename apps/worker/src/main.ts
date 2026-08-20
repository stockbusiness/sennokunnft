import {
  assertCommonUserLinkingConfig,
  assertPhaseOneIntegrationLimits,
  assertProductionSafety,
  assertWalletDeliveryConfig,
  assertWalletRevocationConfig,
  loadEnv,
  UnsafeEnvironmentError,
  workerEnvSchema,
} from '@sengoku/config';
import {
  createPrismaClient,
  PrismaCommonUserLinkRepository,
  PrismaIntegrationRepository,
  PrismaWalletDeliveryOutboxRepository,
  PrismaOrderRepository,
  type PrismaClient,
} from '@sengoku/database';
import {
  AeadSecretBox,
  AgencyCommonUserDirectory,
  HttpWalletDeliverySender,
  parseEncryptionKeys,
  SystemClock,
} from '@sengoku/integrations';
import { RELEASE_BATCH_SIZE } from '@sengoku/domain';
import { createLogger } from '@sengoku/observability';
import { createCommonUserLinkJob } from './common-user-job';
import { createWalletDeliveryJob } from './wallet-delivery-job';
import { createReservationReleaseJob } from './reservation-release-job';
import { createWalletDeliveryResolver } from './wallet-delivery-config';
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
    // 有効なのに宛先や鍵が無い状態で起動させない。
    // 起動すると配送だけが全件失敗して溜まり、利用者の画面は
    // 「お届け中」のままなので誰も異常に気づけない。
    assertWalletDeliveryConfig(env);
    // ⚠️ 取消だけ配送を有効にしても 1 件も送られない。黙って起動させない。
    assertWalletRevocationConfig(env);
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

  // OVEW Wallet への配送。⚠️ 既定は無効（PR-NW04 §37）。
  // フラグが立っていなければハンドラそのものを登録しない。
  if (env.WALLET_DELIVERY_ENABLED) {
    const prisma = (await createPrismaClient({ databaseUrl: env.DATABASE_URL })) as PrismaClient;
    const clock = new SystemClock();

    /*
      管理画面で設定した接続先・鍵を読む口（要決定 03）。

      ⚠️ **暗号鍵が無ければ持たない。** 持たせても復号できず、
         毎巡「半端な設定」で止まる。落ち先（環境変数）だけで動かす。

      ⚠️ **鍵の中身をログへ出さない。** 出すのは「何本読めたか」だけ。
    */
    const walletIntegrations =
      env.INTEGRATION_ENCRYPTION_KEYS === undefined
        ? null
        : (() => {
            const keys = parseEncryptionKeys(env.INTEGRATION_ENCRYPTION_KEYS ?? '');
            const version = env.INTEGRATION_ENCRYPTION_ACTIVE_VERSION;
            if (keys[version] === undefined) {
              // ⚠️ ここで落とす。起動してから最初の送信で気付くのでは遅い。
              logger.fatal(
                { keyCount: Object.keys(keys).length },
                `INTEGRATION_ENCRYPTION_ACTIVE_VERSION（${version}）に対応する鍵がありません。`,
              );
              process.exit(1);
            }
            logger.info(
              { keyCount: Object.keys(keys).length },
              '管理画面で設定した Wallet の接続先を読みます',
            );
            return new PrismaIntegrationRepository(
              prisma,
              new AeadSecretBox({ keys, activeKeyVersion: version }),
            );
          })();
    handlers.push(
      createWalletDeliveryJob({
        logger,
        batchSize: env.WALLET_DELIVERY_BATCH_SIZE,
        outbox: new PrismaWalletDeliveryOutboxRepository(prisma),
        clock,
        /*
          送ってよい種別（M3a）。
          ⚠️ **付与は常に送る。** ここに到達している時点で
             `WALLET_DELIVERY_ENABLED` は有効であり、それは付与の配送を
             意味する。取消の配送だけを別のフラグで足す。
          ⚠️ 取消を止めても付与は止めない。段階導入の途中で付与まで
             止まると、受け取った方の画面が「お届け中」のまま進まない。
        */
        eventTypes: env.WALLET_REVOCATION_EVENT_DELIVERY_ENABLED
          ? ['entitlement.granted', 'entitlement.revoked']
          : ['entitlement.granted'],
        /*
          ⚠️ **接続先と鍵は 1 巡ごとに解決する（要決定 03）。**
             起動時に 1 個作って使い回すと、管理画面で鍵を交換しても
             再起動するまで古い鍵で送り続ける。手順で埋める前提は、
             忘れられたときに誰も気づけない。

          ⚠️ **暗号鍵が無い環境では DB を見ない。** 見に行っても復号できず、
             毎巡「半端な設定」で止まる。落ち先（環境変数）だけで動かす。
        */
        resolve: createWalletDeliveryResolver({
          integrations: walletIntegrations,
          appEnvironment: env.APP_ENV === 'production' ? 'production' : 'staging',
          fallback:
            env.WALLET_DELIVERY_ENDPOINT === undefined
              ? null
              : {
                  // 上のガードで存在を確認済み。
                  endpoint: env.WALLET_DELIVERY_ENDPOINT,
                  keyId: env.WALLET_DELIVERY_KEY_ID ?? '',
                  secret: env.WALLET_DELIVERY_SECRET ?? '',
                  timeoutMs: env.WALLET_DELIVERY_TIMEOUT_MS,
                },
        }),
        createSender: (config) =>
          new HttpWalletDeliverySender({
            endpoint: config.endpoint,
            keyId: config.keyId,
            secret: config.secret,
            clock,
            timeoutMs: config.timeoutMs,
          }),
      }),
    );
    logger.info({ batchSize: env.WALLET_DELIVERY_BATCH_SIZE }, 'Wallet 配送を有効化しました');
  }

  /*
    期限切れのお取り置きの解放（決済 Phase P1・指示書 §4.4）。

    ⚠️ **フラグで切らない。** 解放しないと、決済されなかった枠が
       永久に押さえられたままになり、在庫があるのに買えなくなる。
       止めてよい仕事ではないので、常に登録する。

    ⚠️ **API 側の内部エンドポイントと二重に持つ。** どちらか一方だけを
       置くと、worker を常駐させない配備（UD-302 未決）では誰も掃除せず、
       常駐させる配備では cron を設定し忘れる。同じ処理を 2 経路から
       呼んでも、条件付き更新が二重解放を防ぐ。
  */
  {
    const prisma = (await createPrismaClient({ databaseUrl: env.DATABASE_URL })) as PrismaClient;
    const releaseClock = new SystemClock();
    handlers.push(
      createReservationReleaseJob({
        orders: new PrismaOrderRepository(prisma),
        logger,
        now: () => releaseClock.now(),
        batchSize: RELEASE_BATCH_SIZE,
      }),
    );
  }

  // 発行ジョブは Phase 5-6 で追加する。

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
