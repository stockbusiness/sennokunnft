import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import {
  apiEnvSchema,
  assertClaimApiConfig,
  assertWalletDeliveryConfig,
  assertMediaStorageConfig,
  assertSupabaseAuthConfig,
  assertPhaseOneIntegrationLimits,
  assertProductionSafety,
  loadEnv,
  parseHmacKeys,
  UnsafeEnvironmentError,
} from '@sengoku/config';
import { createLogger } from '@sengoku/observability';
import {
  checkDatabaseConnection,
  createPrismaClient,
  PrismaAccountRepository,
  PrismaIntegrationRepository,
  PrismaStaffInvitationRepository,
  PrismaStaffMemberRepository,
  PrismaArtworkRepository,
  PrismaAuditLogRepository,
  PrismaAuditLogReadRepository,
  PrismaWalletDeliveryAdminRepository,
  PrismaWalletDeliveryOutboxRepository,
  PrismaListingRepository,
  PrismaIdempotencyStore,
  PrismaClaimRepository,
  PrismaNonceStore,
  type PrismaClient,
} from '@sengoku/database';
import {
  DevTokenVerifier,
  SupabaseTokenVerifier,
  InMemoryRateLimiter,
  LocalFileStorage,
  R2Storage,
  SenNoKuniHmacVerifier,
  Sha256ClaimTokenService,
  SystemClock,
  contentHash,
  UuidGenerator,
  generateStorageKey,
  AeadSecretBox,
  parseEncryptionKeys,
} from '@sengoku/integrations';
import { AppModule, type AppDependencies } from './app.module';
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
    // ⚠️ 有効なのに鍵が無ければ起動しない。
    //    起動させると相手の要求が全部 403 で落ち、攻撃と設定漏れの区別がつかない。
    assertClaimApiConfig(env);
    // ⚠️ 配送が有効なのに宛先や鍵が無ければ起動しない。
    //    起動させると受取は成立し続け、配送だけが全件溜まる。
    //    利用者の画面は「お届け中」のままなので、誰も異常に気づけない。
    assertWalletDeliveryConfig(env);
    // ⚠️ r2 なのに設定が欠けたまま起動させない。
    //    起動すると画像のアップロードだけが失敗し、
    //    「画像の無い作品」ができあがる。表面化するのは配送の段。
    assertMediaStorageConfig(env);
    assertSupabaseAuthConfig(env);
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

  // 4. トークン検証（`UD-801` 決定済 2026-08-18: JWKS / ES256）。
  //
  //    ⚠️ **本番で dev を使えないことは assertProductionSafety が保証している。**
  //    ここで分岐を書き足しても、その保証は弱めない。
  let tokenVerifier;
  if (env.AUTH_PROVIDER === 'supabase') {
    // 設定の欠けは assertSupabaseAuthConfig が起動時に止めている。
    // ここに来た時点で揃っているが、型のために確かめる。
    if (env.SUPABASE_JWKS_URL === undefined || env.SUPABASE_JWT_ISSUER === undefined) {
      logger.fatal(
        { variable: 'SUPABASE_JWKS_URL / SUPABASE_JWT_ISSUER' },
        '認証に必要な環境変数が設定されていないため起動を中止しました',
      );
      process.exit(1);
    }
    tokenVerifier = new SupabaseTokenVerifier({
      jwksUrl: env.SUPABASE_JWKS_URL,
      issuer: env.SUPABASE_JWT_ISSUER,
      audience: env.SUPABASE_JWT_AUDIENCE,
    });
  } else {
    if (env.AUTH_DEV_SECRET === undefined) {
      logger.fatal(
        { variable: 'AUTH_DEV_SECRET' },
        '認証に必要な環境変数が設定されていないため起動を中止しました',
      );
      process.exit(1);
    }
    tokenVerifier = new DevTokenVerifier({
      secret: env.AUTH_DEV_SECRET,
      issuer: env.SUPABASE_JWT_ISSUER ?? 'sennokunnft-dev',
      audience: env.SUPABASE_JWT_AUDIENCE,
    });
  }

  // Claim（OVEW Wallet 連携）。既定は無効。
  // ✅ 相手側の署名器が v1.1 FINAL へ揃い、固定ベクトルが両システムで
  //    一致してから有効にする（指示書 §12 の着手条件 10・11）。
  const claimVerifier =
    env.CLAIM_API_ENABLED && env.CLAIM_HMAC_KEYS !== undefined
      ? new SenNoKuniHmacVerifier({
          secrets: parseHmacKeys(env.CLAIM_HMAC_KEYS),
          // ⚠️ nonce は DB に置く。プロセス内メモリだと台数を増やした瞬間に
          //    別プロセスの記録が見えず、リプレイを素通しする。
          nonces: new PrismaNonceStore(prisma),
        })
      : null;

  // 画像の保存先（UD-508 で Cloudflare R2 に決定）。
  //
  // ⚠️ **`local` は再起動で消える。** コンテナの一時領域に書くため。
  //    本番・staging では必ず `r2` にする。設定の不足は
  //    assertMediaStorageConfig が起動時に止めている。
  const storage =
    env.MEDIA_STORAGE_PROVIDER === 'r2'
      ? new R2Storage({
          // 上のガードで存在を確認済み。
          accountId: env.R2_ACCOUNT_ID ?? '',
          bucket: env.R2_BUCKET ?? '',
          accessKeyId: env.R2_ACCESS_KEY_ID ?? '',
          secretAccessKey: env.R2_SECRET_ACCESS_KEY ?? '',
          publicBaseUrl: env.MEDIA_PUBLIC_BASE_URL ?? '',
        })
      : new LocalFileStorage(env.MEDIA_STORAGE_DIR, env.MEDIA_PUBLIC_PREFIX);

  /**
   * 外部連携の設定と資格情報（管理画面・外部連携 指示書 §6.2）。
   *
   * ⚠️ **暗号鍵が無ければ経路ごと生やさない。** 「登録はできるが開けない」
   * 状態を作らないため。鍵の欠けは、設定画面の 500 ではなく起動ログで気付く。
   *
   * ⚠️ **鍵の中身をログへ出さない。** 出すのは「何本読めたか」だけ。
   */
  const integrations = ((): AppDependencies['integrations'] => {
    if (env.INTEGRATION_ENCRYPTION_KEYS === undefined) {
      logger.warn('外部連携の設定機能は無効です（INTEGRATION_ENCRYPTION_KEYS が未設定）。');
      return undefined;
    }

    const keys = parseEncryptionKeys(env.INTEGRATION_ENCRYPTION_KEYS);
    const version = env.INTEGRATION_ENCRYPTION_ACTIVE_VERSION;
    if (keys[version] === undefined) {
      // ⚠️ ここで落とす。起動してから最初の保存で気付くのでは遅い。
      logger.error(
        { keyCount: Object.keys(keys).length },
        `INTEGRATION_ENCRYPTION_ACTIVE_VERSION（${version}）に対応する鍵がありません。`,
      );
      process.exit(1);
    }

    logger.info({ keyCount: Object.keys(keys).length }, '外部連携の設定機能を有効化しました');
    return {
      repository: new PrismaIntegrationRepository(
        prisma,
        new AeadSecretBox({ keys, activeKeyVersion: version }),
      ),
      // ⚠️ 設定の environment は、このプロセスの APP_ENV に固定する。
      //    要求から受け取れるようにすると、本番から staging を書き換えられる。
      appEnvironment: env.APP_ENV === 'production' ? 'production' : 'staging',
    };
  })();

  const app = await NestFactory.create(
    AppModule.register({
      version: VERSION,
      probes,
      artworks: new PrismaArtworkRepository(prisma),
      listings: new PrismaListingRepository(prisma),
      accounts: new PrismaAccountRepository(prisma),
      // 運営スタッフの在籍と招待（`UD-803`）。
      staffMembers: new PrismaStaffMemberRepository(prisma),
      staffInvitations: new PrismaStaffInvitationRepository(prisma),
      integrations,
      /*
        送信の運用画面と監査ログ（管理画面・外部連携 指示書 §5）。

        ⚠️ **読む口と送り直す口を分けて渡す。** 読む口は本文を返さない型で、
           送り直す口は状態を戻すだけ。画面向けの経路から本文へ手が届かない。
      */
      walletDeliveries: {
        admin: new PrismaWalletDeliveryAdminRepository(prisma),
        outbox: new PrismaWalletDeliveryOutboxRepository(prisma),
      },
      auditLogs: new PrismaAuditLogReadRepository(prisma),
      // ⚠️ 冪等キーは DB に置く。プロセス内メモリだと台数を増やした瞬間に効かなくなる。
      idempotency: new PrismaIdempotencyStore(prisma),
      tokenVerifier,
      clock: new SystemClock(),
      ids: new UuidGenerator(),
      storage,
      audit: new PrismaAuditLogRepository(prisma),
      generateStorageKey,
      hashContent: contentHash,
      claim: {
        enabled: env.CLAIM_API_ENABLED,
        claims: new PrismaClaimRepository(prisma),
        tokens: new Sha256ClaimTokenService(),
        verifier: claimVerifier,
        logger,
        // ⚠️ プロセス内メモリのため、台数を増やすと実効の上限が台数倍になる。
        //    増やすときは上限を割るか、共有の実装へ差し替える（UD-1101）。
        rateLimiter: new InMemoryRateLimiter(),
        getPerMinute: env.CLAIM_RATE_LIMIT_GET_PER_MIN,
        postPerMinute: env.CLAIM_RATE_LIMIT_POST_PER_MIN,
        claimBaseUrl: env.CLAIM_BASE_URL.replace(/\/+$/, ''),
        // ⚠️ 既定は無効。画像の長期URL（Cloudflare R2）が整うまで有効にしない。
        deliveryEnabled: env.WALLET_DELIVERY_ENABLED,
      },
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
