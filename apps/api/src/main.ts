import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import {
  apiEnvSchema,
  assertClaimApiConfig,
  assertWalletDeliveryConfig,
  assertMediaStorageConfig,
  assertSupabaseAuthConfig,
  assertStripeConfig,
  assertPhaseOneIntegrationLimits,
  assertProductionSafety,
  loadEnv,
  parseHmacKeys,
  UnsafeEnvironmentError,
  STRIPE_TEST_KEY_PREFIX,
  STRIPE_LIVE_KEY_PREFIX,
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
  PrismaLegalDocumentRepository,
  PrismaWalletDeliveryAdminRepository,
  PrismaWalletDeliveryOutboxRepository,
  PrismaListingRepository,
  PrismaIdempotencyStore,
  PrismaOrderRepository,
  PrismaPaymentRepository,
  PrismaPlatformFeeRateReader,
  PrismaCommonUserLinkRepository,
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
  CryptoRandom,
  FakePaymentGateway,
  StripePaymentGateway,
  ResolvingPaymentGateway,
  createPaymentConfigResolver,
  createPlatformFeeRateResolver,
  generateStorageKey,
  AeadSecretBox,
  parseEncryptionKeys,
  ReachabilityProbe,
} from '@sengoku/integrations';
import { describeIntegrationEnvironment } from './integration/environment-summary';
import type { PaymentGatewayPort } from '@sengoku/domain';
import { AppModule, type AppDependencies } from './app.module';
import { DomainErrorFilter } from './common/domain-error.filter';
import {
  assertDecoratorMetadata,
  DecoratorMetadataMissingError,
} from './common/decorator-metadata';
import { NestStructuredLogger } from './common/nest-logger';
import type { DependencyProbe } from './health/health.service';

const VERSION = '0.1.0';

/**
 * API プロセスの起動。
 *
 * 起動順序に意味がある:
 *  0. 実行環境が型の情報を残しているかを確かめる
 *  1. 環境変数を検証する（不足していれば**この時点で異常終了**する）
 *  2. 設定の組み合わせが安全かを検査する
 *  3. アプリケーションを組み立てる
 *
 * 「起動はしたが設定が欠けていて一部機能が壊れている」状態を作らないため、
 * 検証を通過するまでサーバーを立ち上げない。
 */
/**
 * 鍵からモードだけを取り出す。
 *
 * ⚠️ **判別した結果しか返さない。** 鍵そのものも、その一部も返さない。
 * 画面が要るのは「取り違えていないか」を人が確かめられる粒度までで、
 * 値そのものではない。
 */
function stripeMode(secretKey: string | undefined): 'test' | 'live' | 'unknown' {
  if (secretKey === undefined || secretKey === '') {
    return 'unknown';
  }
  if (secretKey.startsWith(STRIPE_TEST_KEY_PREFIX)) {
    return 'test';
  }
  if (secretKey.startsWith(STRIPE_LIVE_KEY_PREFIX)) {
    return 'live';
  }
  return 'unknown';
}

async function bootstrap(): Promise<void> {
  /*
    0. 実行環境の検査。

    ⚠️ **環境変数より前に見る。** ここが崩れていると、環境変数が
       すべて揃っていても全エンドポイントが 500 を返す。しかも起動は
       成功したように見え、エラーログも出ない。順番を後ろへ動かさないこと。

    ⚠️ **logger より前なので `console` を使う。** logger の生成にも
       設定が要るが、ここで止めたい相手は設定とは無関係の壊れ方である。
  */
  try {
    assertDecoratorMetadata();
  } catch (error) {
    if (error instanceof DecoratorMetadataMissingError) {
      console.error(`api を起動できません。\n\n${error.message}`);
      process.exit(1);
    }
    throw error;
  }

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
    /*
      ⚠️ 鍵の取り違えを起動時に止める（決済 Phase P2・指示書 §11）。
         staging に本番鍵を入れると、動作確認のつもりで本物のお金が動く。
         production にテスト鍵を入れると、決済は全部通ったように見えて
         入金が 1 円も無い。どちらも起動させない。
    */
    assertStripeConfig(env);
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

  /*
    決済の記録。⚠️ 決済を繋いでいない配備でも作る。管理画面の状態表示
    （最後に知らせが届いた時刻）は、決済が無効でも見えたほうがよい。
    「届いているのに処理されていない」ことに気づける唯一の手掛かりになる。
  */
  const paymentRepository = new PrismaPaymentRepository(prisma);

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
      /*
        ⚠️ **業務データを送らない確認だけを渡す**（指示書 §4.3・要決定 06）。
           相手は受取権を作る口で、試し打ちしてよい相手ではない。
           安全なテスト手段が先方で確認できるまで、実送信は作らない。
      */
      probe: (endpointUrl, timeoutMs) =>
        new ReachabilityProbe({ clock: new SystemClock(), timeoutMs }).probe(endpointUrl),
      /*
        画像の保管先とログインは、配備環境が正（`UD-508` と指示書 §14）。
        ⚠️ **値を渡さない。** 渡すのは方式と、欠けている設定の名前まで。
      */
      describeEnvironment: describeIntegrationEnvironment(env),
      /*
        決済の配備側の状態。
        ⚠️ **鍵そのもの・先頭・末尾を渡さない**（2026-08-19 決定）。
           渡すのは「設定されているか」「テストか本番か」まで。
           モードは鍵の頭で判別するが、判別した結果しか外へ出さない。
      */
      describePaymentDeployment: async () => ({
        secretKeyConfigured: (env.STRIPE_SECRET_KEY ?? '') !== '',
        webhookSecretConfigured: (env.STRIPE_WEBHOOK_SECRET ?? '') !== '',
        mode: stripeMode(env.STRIPE_SECRET_KEY),
        lastWebhookReceivedAt:
          paymentRepository === null
            ? null
            : await paymentRepository.findLastWebhookReceivedAt(env.PAYMENT_PROVIDER),
      }),
      repository: new PrismaIntegrationRepository(
        prisma,
        new AeadSecretBox({ keys, activeKeyVersion: version }),
      ),
      // ⚠️ 設定の environment は、このプロセスの APP_ENV に固定する。
      //    要求から受け取れるようにすると、本番から staging を書き換えられる。
      appEnvironment: env.APP_ENV === 'production' ? 'production' : 'staging',
    };
  })();

  /*
    決済ゲートウェイ。

    ⚠️ **`fake` でも口を生やす。** Stripe の鍵を持たない人が手元で
       購入の流れを最後まで通せるようにするため（指示書 §5.4）。
       擬似実装でも署名の作り方と検証の手順は Stripe と同じにしてある。
    ⚠️ **鍵が欠けていれば `null`。** 起動時の検査（`assertStripeConfig`）が
       `stripe` のときは既に止めているので、ここへ来るのは
       `PAYMENT_WEBHOOK_SECRET` を入れていない `fake` の場合だけ。
  */
  /*
    ⚠️ **設定は呼び出しのたびに引く。** 管理画面で鍵・戻り先・手数料率を
       変えたら、次の呼び出しから効いてほしい。起動時に読んだ値を
       持ち回ると「保存できたのに効かない」になり、しかも効いていない
       ことに気づく手掛かりが無い。

    ⚠️ **環境変数は引き継ぎ元。** DB に鍵が入るまではこちらが正で、
       入ったあとは DB が正。DB 側で止めてあるときは環境変数へ
       落ちない（落ちると管理画面の「停止」が効かない）。
  */
  const paymentConfigResolver = createPaymentConfigResolver({
    integrations: integrations?.repository ?? null,
    appEnvironment: integrations?.appEnvironment ?? 'staging',
    deployment:
      env.PAYMENT_PROVIDER === 'stripe'
        ? {
            // 起動時のガード（`assertStripeConfig`）で存在を確認済み。
            secretKey: env.STRIPE_SECRET_KEY ?? '',
            webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? '',
            apiVersion: env.STRIPE_API_VERSION,
            successUrlTemplate: env.STRIPE_CHECKOUT_SUCCESS_URL ?? '',
            cancelUrlTemplate: env.STRIPE_CHECKOUT_CANCEL_URL ?? '',
          }
        : null,
  });

  const paymentGateway = ((): PaymentGatewayPort | null => {
    if (env.PAYMENT_PROVIDER === 'stripe') {
      return new ResolvingPaymentGateway(
        paymentConfigResolver,
        (config) =>
          new StripePaymentGateway({
            secretKey: config.secretKey,
            webhookSecret: config.webhookSecret,
            apiVersion: config.apiVersion === '' ? env.STRIPE_API_VERSION : config.apiVersion,
            successUrlTemplate: config.successUrlTemplate,
            cancelUrlTemplate: config.cancelUrlTemplate,
          }),
        'stripe',
      );
    }
    if (env.PAYMENT_WEBHOOK_SECRET === undefined) {
      logger.warn({}, '決済の機能は無効です（PAYMENT_WEBHOOK_SECRET が未設定）。');
      return null;
    }
    return new FakePaymentGateway(env.PAYMENT_WEBHOOK_SECRET);
  })();

  /*
    手数料率。
    ⚠️ **資格情報とは別に引く。** 率は決済事業者の設定ではなく販売の条件で、
       事業者が `fake`（鍵を持たない手元・E2E）でも要る。束ねると、
       鍵の無い環境で率が 0 に落ちる。
    ⚠️ **注文のたびに引く。** 引いた値は注文へスナップショットされるので、
       あとから率を変えても**過去の注文は動かない**。
  */
  const resolvePlatformFeeRateBps = createPlatformFeeRateResolver({
    /*
      ⚠️ **暗号鍵に依存させない。** 率は秘密ではないので、復号の仕組みを
         通す理由が無い。`integrations`（暗号鍵が要る）に紐づけると、
         鍵を置いていない配備で率が 0 に落ちる。
    */
    reader: new PrismaPlatformFeeRateReader(prisma),
    appEnvironment: env.APP_ENV === 'production' ? 'production' : 'staging',
  });

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
      /*
        法務文書（利用規約・プライバシーポリシー・特商法表記）。

        ⚠️ **暗号鍵を要らない。** 公開する文なので秘密ではない。
           連携設定の保管庫と同じ経路に載せると、鍵を置いていない配備で
           法務ページごと開かなくなる。
      */
      legalDocuments: new PrismaLegalDocumentRepository(prisma),
      // ⚠️ 冪等キーは DB に置く。プロセス内メモリだと台数を増やした瞬間に効かなくなる。
      idempotency: new PrismaIdempotencyStore(prisma),
      /*
        注文と在庫の仮引当（決済 Phase P0・P1）。

        ⚠️ **手数料率は設定から渡す。** ブラウザからは受け取らない（指示書 §4.2）。
           既定 0 は「まだ決めていない」の意味で、決定ではない（UD-109）。
        ⚠️ **`INTERNAL_JOB_TOKEN` が無ければ内部ジョブの経路は生えない。**
           「未設定なら素通し」にすると、設定を忘れた環境で外から在庫を操作できる。
      */
      /*
        決済（決済 Phase P2）。

        ⚠️ **設定が揃っていなければ経路ごと生やさない。** 鍵が無いまま
           Webhook の口だけ開くと、署名を確かめずに受けるか全部拒否するかの
           どちらかになる。前者は誰でも「決済成功」を送れる。
        ⚠️ **`livemode` の期待値は APP_ENV から決める。** 要求から
           受け取れるようにすると、試験の知らせで本番の注文を確定できる。
      */
      payments:
        paymentGateway === null
          ? undefined
          : {
              gateway: paymentGateway,
              repository: paymentRepository,
              provider: env.PAYMENT_PROVIDER,
              expectLivemode: env.APP_ENV === 'production',
              logger,
            },
      orders: {
        repository: new PrismaOrderRepository(prisma),
        commonUserLinks: new PrismaCommonUserLinkRepository(prisma),
        random: new CryptoRandom(),
        resolvePlatformFeeRateBps,
        reservationMinutes: env.ORDER_RESERVATION_MINUTES,
        internalJobToken: env.INTERNAL_JOB_TOKEN,
      },
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
