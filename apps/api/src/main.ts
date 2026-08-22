import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import {
  apiEnvSchema,
  assertClaimApiConfig,
  assertWalletDeliveryConfig,
  assertWalletRevocationConfig,
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
  PrismaLegalConsentRepository,
  PrismaPaymentCredentialRepository,
  PrismaOperationsReviewRepository,
  PrismaRevocationReconcileRepository,
  PrismaWalletDeliveryAdminRepository,
  PrismaWalletDeliveryOutboxRepository,
  PrismaListingRepository,
  PrismaIdempotencyStore,
  PrismaOrderRepository,
  PrismaOrderNoteRepository,
  PrismaSettlementSettingsRepository,
  PrismaCollectibleRepository,
  PrismaEntitlementIssuanceRepository,
  PrismaRefundRepository,
  PrismaPayoutRepository,
  PrismaSalesReportRepository,
  PrismaOperationsAlertSettingsRepository,
  PrismaCreatorDirectoryRepository,
  PrismaCreatorProfileRepository,
  PrismaPaymentRepository,
  PrismaPlatformFeeRateReader,
  PrismaCommonUserLinkRepository,
  PrismaClaimRepository,
  PrismaNonceStore,
  type PrismaClient,
  PrismaAuthSubjectLookup,
  PrismaNotificationHistoryRepository,
  PrismaNotificationOutboxRepository,
  PrismaEntitlementAdminRepository,
  PrismaAttestationRepository,
  PrismaProductionReadinessRepository,
  PrismaAccountNoteRepository,
  PrismaCustomerDirectoryRepository,
  PrismaCreatorEarningsRepository,
  PrismaCreatorProfileDetailRepository,
  PrismaPayoutAccountRepository,
  PrismaEmailChangeRequestRepository,
  PrismaNotificationSweepRepository,
  PrismaOperationsRepository,
  PrismaNotificationTemplateRepository,
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
  createPaymentConfigByCredentialResolver,
  createPlatformFeeRateResolver,
  generateStorageKey,
  AeadSecretBox,
  PayoutAccountSecretBox,
  HttpAlertWebhook,
  AlertWebhookSecretBox,
  parseEncryptionKeys,
  ReachabilityProbe,
  probeStripeAccount,
  HmacEmailHasher,
  ResendMailSender,
  SupabaseRecipientResolver,
} from '@sengoku/integrations';
import {
  acceptingGeneration,
  CREDENTIAL_VERIFICATION_LIMIT,
  DEFAULT_OPERATIONS_THRESHOLDS,
  DEFAULT_PRODUCTION_READINESS_THRESHOLDS,
} from '@sengoku/domain';
import { WATCHED_JOB_KEYS } from './order/internal-jobs.controller';
import { describeIntegrationEnvironment } from './integration/environment-summary';
import { createRefundWindowResolver } from './settlement/refund-window';
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
    // ⚠️ 取消だけ配送を有効にしても 1 件も送られない。黙って起動させない。
    assertWalletRevocationConfig(env);
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

  /*
    法務文書。⚠️ 注文の作成からも引くので、ここで作って共有する。
    ⚠️ 暗号鍵を要らない。公開する文なので秘密ではない。
  */
  const legalDocuments = new PrismaLegalDocumentRepository(prisma);

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
  /*
    秘密情報の封（外部連携と決済の世代で共有する）。

    ⚠️ **鍵が無ければ `null`。** 「渡すが中で落ちる」形にすると、画面を
       開いた人に 500 が返るだけで、原因が鍵の欠けだと分からない。
  */
  const secretCipher = ((): AeadSecretBox | null => {
    if (env.INTEGRATION_ENCRYPTION_KEYS === undefined) {
      return null;
    }
    const keys = parseEncryptionKeys(env.INTEGRATION_ENCRYPTION_KEYS);
    const version = env.INTEGRATION_ENCRYPTION_ACTIVE_VERSION;
    if (keys[version] === undefined) {
      return null;
    }
    return new AeadSecretBox({ keys, activeKeyVersion: version });
  })();

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
        // ⚠️ 上で組んだものを使い回す。ここで作り直すと鍵の版がずれうる。
        secretCipher ?? new AeadSecretBox({ keys, activeKeyVersion: version }),
      ),
      // ⚠️ 設定の environment は、このプロセスの APP_ENV に固定する。
      //    要求から受け取れるようにすると、本番から staging を書き換えられる。
      appEnvironment: env.APP_ENV === 'production' ? 'production' : 'staging',
    };
  })();

  /*
    決済資格情報の世代（`UD-118`）。

    ⚠️ **暗号鍵が無ければ経路ごと生やさない。** 画面を開いた人に 500 が
       返るだけの状態を作らない。
    ⚠️ **緊急上書きが有効なら、起動のたびに警告を出す。** 黙って二重管理が
       復活している状態が、いちばん気づきにくい。
  */
  if (env.PAYMENT_EMERGENCY_CREDENTIAL_OVERRIDE) {
    logger.warn(
      '⚠️ 決済の緊急上書きが有効です（PAYMENT_EMERGENCY_CREDENTIAL_OVERRIDE=true）。' +
        '配備環境の鍵が使われます。復旧が済んだら false へ戻してください。',
    );
  }

  const paymentCredentials = ((): AppDependencies['paymentCredentials'] => {
    if (secretCipher === null) {
      logger.warn('決済資格情報の世代管理は無効です（INTEGRATION_ENCRYPTION_KEYS が未設定）。');
      return undefined;
    }
    const appEnvironment = env.APP_ENV === 'production' ? 'production' : 'staging';
    return {
      repository: new PrismaPaymentCredentialRepository(prisma, secretCipher),
      cipher: secretCipher,
      config: {
        provider: env.PAYMENT_PROVIDER,
        appEnvironment,
        emergencyOverrideActive: env.PAYMENT_EMERGENCY_CREDENTIAL_OVERRIDE,
        countPayments: (credentialId) => paymentRepository.countByCredential(credentialId),
        /*
          ⚠️ **`fake` では実際に外へ出ない。** 手元と E2E で世代の流れを
             通せるようにするための擬似応答。⚠️ `stripe` のときだけ本物を叩く。
        */
        probeAccount: async (secretKey, apiVersion) =>
          env.PAYMENT_PROVIDER === 'stripe'
            ? probeStripeAccount(secretKey, apiVersion)
            : { ok: true, accountRef: `acct_fake_${secretKey.slice(-4)}` },
      },
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
  const paymentConfigOptions = {
    integrations: integrations?.repository ?? null,
    appEnvironment: integrations?.appEnvironment ?? 'staging',
    provider: env.PAYMENT_PROVIDER,
    /*
      ⚠️ **鍵は世代から読む**（`UD-128`）。暗号鍵が無い配備では世代を
         開けないので `null`。そのときは `no_credential` で止まる——
         配備環境の鍵へ黙って落ちない。
    */
    credentials: paymentCredentials?.repository ?? null,
    /*
      ⚠️ **既定は `false`。** 立てると配備環境の鍵を直接使う。
         世代の表を壊した場合の復旧経路であって、常用しない。
         立っているあいだは上で起動のたびに警告を出している。
    */
    emergencyOverride: env.PAYMENT_EMERGENCY_CREDENTIAL_OVERRIDE,
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
  };
  const paymentConfigResolver = createPaymentConfigResolver(paymentConfigOptions);
  /*
    返金のときに、**決済した当時の世代**を開く口（`UD-120`）。

    ⚠️ **受付中の世代では返金できない。** `payment_intent` は発行した
       アカウントに紐づく。運営会社を切り替えたあとに新しい鍵で投げると
       「そんな決済は無い」と断られる（`UD-118` §2）。
  */
  const paymentConfigByCredential = createPaymentConfigByCredentialResolver(paymentConfigOptions);

  /*
    署名検証で試す世代（`UD-128`）。

    ⚠️ **受付中の世代だけでは足りない。** 切り替えたあとも、旧アカウントで
       発生した決済の知らせは届き続ける。新しい世代だけ試すと、旧世代の
       決済が「署名が違う」として捨てられ、支払い済みの注文が未払いのまま残る。
    ⚠️ **緊急上書き中は世代を使わない。** 世代の表が壊れているから
       上書きしているので、そこを読みに行っては復旧にならない。
  */
  const webhookVerificationConfigs = async () => {
    const credentials = paymentCredentials?.repository;
    if (credentials === undefined || env.PAYMENT_EMERGENCY_CREDENTIAL_OVERRIDE) {
      return [];
    }
    const opened = await credentials.openForVerification(
      env.PAYMENT_PROVIDER,
      env.APP_ENV === 'production' ? 'production' : 'staging',
      CREDENTIAL_VERIFICATION_LIMIT,
    );
    return opened.map((row) => ({
      secretKey: row.secretKey,
      webhookSecret: row.webhookSecret,
      apiVersion: row.apiVersion ?? env.STRIPE_API_VERSION,
      // 戻り先は検証に使わないが、型をそろえるために入れる。
      successUrlTemplate: env.STRIPE_CHECKOUT_SUCCESS_URL ?? '',
      cancelUrlTemplate: env.STRIPE_CHECKOUT_CANCEL_URL ?? '',
      settingsSource: 'database' as const,
      keySource: 'generation' as const,
      credentialId: row.id,
    }));
  };

  /*
    受付中の世代があるかを、起動時に確かめる（`UD-128`）。

    ⚠️ **落とさずに、警告で伝える。** DB の状態に依存する条件で
       プロセスを落とすと、DB が一時的に見えないだけで起動できなくなり、
       再起動の輪に入る。売れないことは購入時の応答（`SALES_SETUP_INCOMPLETE` /
       `PAYMENT_CREDENTIAL_CHECK_REQUIRED`）で利用者にも運営にも伝わる。

    ⚠️ **黙って通さない。** ここを黙らせると、「画面では有効なのに売れない」
       状態に誰も気づかないまま本番を迎える。
  */
  if (env.PAYMENT_PROVIDER === 'stripe' && !env.PAYMENT_EMERGENCY_CREDENTIAL_OVERRIDE) {
    const credentials = paymentCredentials?.repository;
    if (credentials === undefined) {
      logger.error(
        '決済の鍵の世代を開けません（INTEGRATION_ENCRYPTION_KEYS が未設定）。支払い口は作れません。',
      );
    } else {
      const generations = await credentials.list(
        env.PAYMENT_PROVIDER,
        env.APP_ENV === 'production' ? 'production' : 'staging',
      );
      if (acceptingGeneration(generations) === null) {
        logger.error(
          { generationCount: generations.length },
          '受付中の決済資格情報の世代がありません。支払い口は作れません。' +
            '`pnpm payment:credential -- --import` で取り込み、`--activate=<id>` で有効化してください。',
        );
      }
    }
  }

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
        webhookVerificationConfigs,
        /*
          ⚠️ **通った世代に印を付ける。** 「まだ旧アカウント宛に決済が
             起きている」ことに気づく唯一の手掛かりで、退役してよいかの
             判断材料にもなる。署名の中身は残さない。
        */
        async (credentialId) => {
          await paymentCredentials?.repository.touchWebhookReceived(credentialId, new Date());
        },
        // ⚠️ 返金は決済した当時の世代で投げる（`UD-120`）。
        paymentConfigByCredential,
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
  /*
    返金・精算の設定（`UD-104` / `UD-119`）。

    ⚠️ **決済確定のたびに引き、注文へ焼き付ける。** 判定のたびに引き直すと、
       設定を変えた瞬間に過去の注文の期限が動く。
    ⚠️ **設定が無ければ `null`。既定値を作らない。** 期限の付かない注文は
       購入者都合の返金が通らなくなるが、**勝手に期限を決めるより良い**。
  */
  const settlementSettings = new PrismaSettlementSettingsRepository(prisma);
  // 返金の記録（`UD-120`）。⚠️ 決済を繋いでいない配備でも読み取りは要る。
  const refundRepository = new PrismaRefundRepository(prisma);

  /*
    受取権の発行（P0-1）。

    ⚠️ **受取トークンの発行器を渡す。** 保存するのはハッシュだけで、平文は
       この境界の外へ出ない。購入者はご自分の画面から受取URLを発行し直す
       （`POST /api/v1/entitlements/:id/claim-token`）。
    ⚠️ **Claim の機能フラグに紐づけない。** 受取権そのものは、Wallet 連携を
       有効にしていない配備でも作られる必要がある。作られないと、
       あとから有効にしたときに過去の注文だけ受取権が無い状態になる。
  */
  const issuanceRepository = new PrismaEntitlementIssuanceRepository(
    prisma,
    new Sha256ClaimTokenService(),
  );
  const settlementEnvironment = env.APP_ENV === 'production' ? 'production' : 'staging';
  const resolveRefundableUntil = createRefundWindowResolver(
    settlementSettings,
    settlementEnvironment,
  );

  const resolvePlatformFeeRateBps = createPlatformFeeRateResolver({
    /*
      ⚠️ **暗号鍵に依存させない。** 率は秘密ではないので、復号の仕組みを
         通す理由が無い。`integrations`（暗号鍵が要る）に紐づけると、
         鍵を置いていない配備で率が 0 に落ちる。
    */
    reader: new PrismaPlatformFeeRateReader(prisma),
    appEnvironment: env.APP_ENV === 'production' ? 'production' : 'staging',
  });

  /*
    購入者への知らせ（P0-4）。
    ⚠️ **送るための道具がそろっていなければ起動を拒否する。** 起動させると、
       知らせだけが全件溜まり、利用者にも運営にも「送れていない」ことが
       見えないまま日が過ぎる。
    ⚠️ **鍵の値をログへ出さない。** 出すのは「どの変数が欠けているか」まで。
  */
  /*
    ご連絡先を取り寄せる口（決定 2026-08-21）。

    ⚠️ **知らせの送信が有効かどうかとは切り離す。** 送信を止めている配備でも、
       問い合わせ対応でご連絡先は要る。`NOTIFICATION_DELIVERY_ENABLED` に
       ぶら下げると、送信を止めた日から応対ができなくなる。

    ⚠️ **`UD-503` は維持したまま。** ここで作るのは「取り寄せる口」であって、
       保存はどこにもしない。取り寄せた値は応答に載せて捨てる。
  */
  const recipientResolver =
    env.SUPABASE_URL !== undefined && env.SUPABASE_SERVICE_ROLE_KEY !== undefined
      ? new SupabaseRecipientResolver(
          { url: env.SUPABASE_URL, serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY },
          new PrismaAuthSubjectLookup(prisma),
        )
      : undefined;

  let notificationDelivery:
    | { readonly recipients: SupabaseRecipientResolver; readonly mailer: ResendMailSender }
    | undefined;
  if (env.NOTIFICATION_DELIVERY_ENABLED) {
    const missing: string[] = [];
    if (env.MAIL_PROVIDER === 'none') missing.push('MAIL_PROVIDER');
    if (env.RESEND_API_KEY === undefined) missing.push('RESEND_API_KEY');
    if (env.MAIL_FROM_ADDRESS === undefined) missing.push('MAIL_FROM_ADDRESS');
    if (env.SUPABASE_SERVICE_ROLE_KEY === undefined) missing.push('SUPABASE_SERVICE_ROLE_KEY');
    if (env.SUPABASE_URL === undefined) missing.push('SUPABASE_URL');
    if (missing.length > 0) {
      logger.fatal(
        { variables: missing },
        '知らせを送る設定が足りないため起動を中止しました（NOTIFICATION_DELIVERY_ENABLED が有効です）',
      );
      process.exit(1);
    }
    /*
      ⚠️ **生成が無効なのに送信だけ有効、という組み合わせを許さない。**
         積まれないので 1 通も送られない。設定した人は「有効にした」と
         思っているので、誰も異常に気づけない。
    */
    if (!env.NOTIFICATION_GENERATION_ENABLED) {
      logger.fatal(
        { variable: 'NOTIFICATION_GENERATION_ENABLED' },
        '知らせを作らない設定のまま送信だけを有効にはできません',
      );
      process.exit(1);
    }
    notificationDelivery = {
      // ⚠️ 上で作った口を使い回す。2 つ作ると、片方だけ設定が変わりうる。
      recipients: recipientResolver!,
      mailer: new ResendMailSender({
        apiKey: env.RESEND_API_KEY!,
        from: env.MAIL_FROM_ADDRESS!,
        replyTo: env.MAIL_REPLY_TO,
      }),
    };
  }

  /*
    時計仕掛けの生死を記録する口（P0-6）。
    ⚠️ **これが無いと「止まっている」を誰も検知できない。** 発行も配送も
       知らせも、止まれば静かに溜まるだけで、エラーは 1 件も出ない。
  */
  const operationsRepository = new PrismaOperationsRepository(prisma);

  const app = await NestFactory.create(
    AppModule.register({
      version: VERSION,
      probes,
      artworks: new PrismaArtworkRepository(prisma),
      listings: new PrismaListingRepository(prisma),
      accounts: new PrismaAccountRepository(prisma),
      // 返金の記録（`UD-104` / `UD-120`）。
      refunds: refundRepository,
      // 受取権の発行（P0-1）。決済が済んだ注文を受取権に変える。
      issuance: issuanceRepository,
      // ご自分が受け取ったもの（P0-3）。⚠️ 絞り込みはリポジトリが必ず行う。
      collectibles: new PrismaCollectibleRepository(prisma),
      /*
        購入者への知らせ（P0-4）。
        ⚠️ **省略できない。** 省略できると、知らせの無い配備が「正常」に
           見える。買った方から見ると、何も届かないのは異常である。
      */
      notification: {
        templates: new PrismaNotificationTemplateRepository(prisma),
        outbox: new PrismaNotificationOutboxRepository(prisma),
        history: new PrismaNotificationHistoryRepository(prisma),
        generationEnabled: env.NOTIFICATION_GENERATION_ENABLED,
        siteName: env.NOTIFICATION_SITE_NAME,
        // ⚠️ 末尾のスラッシュを落とす。文面の中で二重にならないように。
        siteUrl: env.NOTIFICATION_SITE_URL.replace(/\/+$/, ''),
        delivery: notificationDelivery,
        // 「届いた」「止まっている」を状態から数え上げる（P0-4）。
        sweepSource: new PrismaNotificationSweepRepository(prisma),
        logger,
      },
      /*
        運営ダッシュボード（P0-6）。
        ⚠️ **省略できない。** 指標の見えない配備は「正常」に見えてしまい、
           止まっていることに誰も気づけない。
      */
      operations: {
        repository: operationsRepository,
        entitlements: new PrismaEntitlementAdminRepository(prisma),
        thresholds: DEFAULT_OPERATIONS_THRESHOLDS,
        jobKeys: WATCHED_JOB_KEYS,
        /*
          運営への知らせ（`UD-1102` の一部）。
          ⚠️ **購入者向けの知らせの仕組みへ相乗りしない。** あちらが
             止まったとき、止まったことを知らせられなくなる。
          ⚠️ **送る口が無くても配線する。** 画面から宛先を決められる
             ようにしておき、「送れません」は状態として伝える。
        */
        alerts: {
          settings: new PrismaOperationsAlertSettingsRepository(prisma),
          dashboardUrl: `${env.NOTIFICATION_SITE_URL.replace(/\/+$/, '')}/admin`,
          mailer: notificationDelivery?.mailer ?? null,
          webhook: new HttpAlertWebhook(),
          /*
            ⚠️ **暗号鍵が無ければ受け口を預からない。** 平文で置く逃げ道を
               作れば、鍵の設定を忘れた配備で静かに合言葉が溜まる。
          */
          cipher: secretCipher === null ? null : new AlertWebhookSecretBox(secretCipher),
        },
      },
      /*
        本番販売ガード（P0-7）。
        ⚠️ **省略できない。** 繋ぎ忘れた配備でガードごと消えるのは、
           「売ってよい」と判定するのと同じである。
        ⚠️ **`environment` はプロセスの環境。** 要求から受け取らない。
           受け取れると、本番のプロセスで staging の判定を通せてしまう。
      */
      production: {
        readiness: new PrismaProductionReadinessRepository(
          prisma,
          settlementEnvironment,
          env.PAYMENT_PROVIDER,
        ),
        attestations: new PrismaAttestationRepository(prisma, settlementEnvironment),
        environment: settlementEnvironment,
        thresholds: DEFAULT_PRODUCTION_READINESS_THRESHOLDS,
        /*
          メールの試し送り。
          ⚠️ **送信の配線を使い回す。** 別に鍵を読む口を作ると、
             「試し送りは通るが本番の知らせは届かない」が起きうる。
             確かめたいのは、まさにその本番の経路である。
        */
        mailTestSender: notificationDelivery?.mailer ?? null,
      },
      /*
        顧客サポート（P1-1）。
        ⚠️ **付け替えの口をここに足さない。** 注文・受取権・ウォレットの
           持ち主を人が変えられる依存は、この形に存在しない。
      */
      /*
        作家さま運営（P1-2）。
        ⚠️ **誰の分かを要求から受け取る口を足さない。** 売上はその方の
           商いの中身そのもので、他人が覗いてよいものではない。
      */
      creatorOperations: {
        profiles: new PrismaCreatorProfileDetailRepository(prisma),
        earnings: new PrismaCreatorEarningsRepository(prisma),
        /*
          お振込先（P1-3）。
          ⚠️ **暗号鍵が無ければ預からない。** 平文で置く逃げ道を作らない——
             作れば、鍵の設定を忘れた配備で静かに平文が溜まる。
          ⚠️ 画面は「まだご登録いただけません」と断る（起動はする）。
        */
        ...(secretCipher === null
          ? {}
          : {
              payoutAccounts: {
                store: new PrismaPayoutAccountRepository(prisma),
                cipher: new PayoutAccountSecretBox(secretCipher),
              },
            }),
      },
      customers: {
        directory: new PrismaCustomerDirectoryRepository(prisma),
        notes: new PrismaAccountNoteRepository(prisma),
        emailChanges: new PrismaEmailChangeRequestRepository(prisma),
        /*
          ⚠️ **無い配備がある。** 認証基盤へ繋いでいなければ `undefined` の
             まま。画面は「この配備では取り寄せられません」と断る。
             必須にすると、繋いでいない配備で起動しなくなる。
        */
        ...(recipientResolver === undefined ? {} : { recipients: recipientResolver }),
      },
      // 作家さまへの精算（`UD-119`）。
      payouts: new PrismaPayoutRepository(prisma),
      /*
        運営の売上レポートと作家さまの一覧（`UD-123` / `UD-124` の一部）。
        ⚠️ **読み取りだけ。** ここへ「直す」実装を足さない。
      */
      reporting: {
        sales: new PrismaSalesReportRepository(prisma),
        creators: new PrismaCreatorDirectoryRepository(prisma),
      },
      // 作家さまの表示名（決定 2026-08-20）。
      profiles: new PrismaCreatorProfileRepository(prisma),
      // 運用確認キュー（M3a）。機械が決められなかったことを残す。
      operationsReviews: new PrismaOperationsReviewRepository(prisma),
      /*
        全額返金にともなう取消（M3a）。⚠️ **3 つとも既定は無効。**

        ⚠️ **フラグを 1 本にまとめない。** 止めたい対象が 3 段ある
           （業務方針そのもの／作るか／送るか）。まとめると、送信だけ
           止めたい場面で生成まで止まり、**止めていた期間の返金が
           永久に相手へ伝わらなくなる**。
      */
      revocation: {
        revokeClaimed: env.REFUND_REVOKE_CLAIMED_ENABLED,
        generationEnabled: env.WALLET_REVOCATION_EVENT_GENERATION_ENABLED,
        reconcile: new PrismaRevocationReconcileRepository(prisma),
        outbox: new PrismaWalletDeliveryOutboxRepository(prisma),
        logger,
      },
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
      paymentCredentials,
      legalDocuments: {
        documents: legalDocuments,
        consents: new PrismaLegalConsentRepository(prisma),
      },
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
              resolveRefundableUntil,
              logger,
            },
      orders: {
        repository: new PrismaOrderRepository(prisma),
        notes: new PrismaOrderNoteRepository(prisma),
        commonUserLinks: new PrismaCommonUserLinkRepository(prisma),
        random: new CryptoRandom(),
        resolvePlatformFeeRateBps,
        /*
          注文へ残す規約の版（`UD-126`）。
          ⚠️ **同意を確かめる口ではない。** 同意は会員登録のときに取る。
             ここは「何が表示されていたか」を注文へ残すためだけに引く。
          ⚠️ 未公開なら null。**注文を止めない。** 止めると、規約を
             公開する前に手元で試すことができなくなる。
        */
        resolveEffectiveTerms: async () => {
          const effective = await legalDocuments.findEffective('terms', new Date());
          return effective === null ? null : { id: effective.id, version: effective.version };
        },
        reservationMinutes: env.ORDER_RESERVATION_MINUTES,
        internalJobToken: env.INTERNAL_JOB_TOKEN,
      },
      tokenVerifier,
      /**
       * 問い合わせでメールから注文を辿るための変換（`UD-121`）。
       *
       * ⚠️ 鍵が無ければ照合値は付かない。素のハッシュへは落とさない。
       */
      emailHasher: new HmacEmailHasher(env.EMAIL_LOOKUP_PEPPER ?? null),
      settlement: settlementSettings,
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
