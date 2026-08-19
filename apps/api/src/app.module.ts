import {
  Module,
  type DynamicModule,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import express from 'express';
import type { AccountLookupPort, TokenVerifierPort } from '@sengoku/auth';
import type {
  ArtworkRepository,
  ClaimTokenPort,
  RateLimiterPort,
  IdempotencyStore,
  AuditLogPort,
  ClockPort,
  IdGeneratorPort,
  ListingRepository,
  StoragePort,
  StaffInvitationRepository,
  StaffMemberRepository,
  IntegrationRepository,
  AuditLogReadPort,
  OrderRepository,
  PaymentRepository,
  PaymentGatewayPort,
  CommonUserLinkRepository,
  RandomPort,
  WalletDeliveryAdminPort,
  WalletDeliveryOutboxPort,
  IntegrationEnvironment,
  IntegrationSettings,
  IntegrationService as IntegrationServiceName,
  EnvIntegrationSummary,
  ProbeOutcome,
} from '@sengoku/domain';
import type { SenNoKuniHmacVerifier } from '@sengoku/integrations';
import type { Logger } from '@sengoku/observability';
import { AuthGuard } from './auth/auth.guard';
import { ClaimController } from './claim/claim.controller';
import { ClaimService } from './claim/claim.service';
import { WalletDeliveryPlanner } from './claim/delivery.planner';
import { ClaimReissueController } from './claim/reissue.controller';
import { ReissueService, type ClaimTokenRotationSource } from './claim/reissue.service';
import { CLAIM_HMAC_CONFIG, SenNoKuniHmacGuard, type ClaimHmacConfig } from './claim/hmac.guard';
import {
  CLAIM_RATE_LIMIT_CONFIG,
  ClaimRateLimitGuard,
  type ClaimRateLimitConfig,
} from './claim/rate-limit.guard';
import type { ContentHasher } from './common/content-hash';
import { CorrelationMiddleware } from './common/correlation.middleware';
import { IdempotencyService } from './common/idempotency';
import { AdminCatalogController } from './catalog/admin-catalog.controller';
import { AdminCatalogService } from './catalog/admin-catalog.service';
import { CreatorCatalogController } from './catalog/creator-catalog.controller';
import { CreatorCatalogService } from './catalog/creator-catalog.service';
import { CatalogController, PublicListingController } from './catalog/catalog.controller';
import { CatalogService } from './catalog/catalog.service';
import { ArtworkImageService, type StorageKeyFactory } from './catalog/image.service';
import { StaffController, StaffInvitationAcceptController } from './staff/staff.controller';
import { StaffService } from './staff/staff.service';
import { IntegrationController } from './integration/integration.controller';
import {
  IntegrationService_,
  type PaymentDeploymentStatus,
} from './integration/integration.service';
import { WalletDeliveryController } from './wallet-delivery/wallet-delivery.controller';
import { WalletDeliveryAdminService } from './wallet-delivery/wallet-delivery.service';
import {
  OrderController,
  AdminOrderController,
  CheckoutController,
} from './order/order.controller';
import { OrderService } from './order/order.service';
import { CheckoutService } from './order/checkout.service';
import { PaymentWebhookService } from './order/webhook.service';
import { PaymentWebhookController } from './order/webhook.controller';
import {
  INTERNAL_JOB_CONFIG,
  InternalJobsController,
  type InternalJobConfig,
} from './order/internal-jobs.controller';
import { AuditLogController } from './audit/audit.controller';
import { AuditLogQueryService } from './audit/audit.service';
import { HealthController } from './health/health.controller';
import { HealthService, type DependencyProbe } from './health/health.service';

/**
 * アプリケーションが必要とする外部依存。
 *
 * 具体的な実装クラスではなく**ポート**を受け取る。
 * こうしておくと、テストからは Fake を、本番からは Prisma 実装を差し込める。
 * DI コンテナに実装クラスを直接登録すると、
 * コントローラのテストのたびに実 DB が必要になってしまう。
 */
export interface AppDependencies {
  readonly version: string;
  readonly probes?: readonly DependencyProbe[];
  readonly artworks: ArtworkRepository;
  readonly listings: ListingRepository;
  readonly accounts: AccountLookupPort;
  /** 運営スタッフの在籍と招待（`UD-803`）。 */
  readonly staffMembers: StaffMemberRepository;
  readonly staffInvitations: StaffInvitationRepository;
  /**
   * 外部連携の設定と資格情報（管理画面・外部連携 指示書）。
   *
   * ⚠️ **暗号鍵が無い環境では渡さない。** 「渡すが中で落ちる」形にすると、
   * 設定画面を開いた人に 500 が返るだけで、原因が鍵の欠けだと分からない。
   * 経路ごと生やさないほうが、起動ログで気付ける。
   */
  readonly integrations?: {
    /**
     * 接続先へ届くかどうかを確かめる手段（指示書 §4.3・要決定 06）。
     *
     * ⚠️ **業務データを送る実装を渡さない。** 相手は受取権を作る口で、
     * 試し打ちしてよい相手ではない。安全なテスト手段が確認できるまで、
     * 本文を持たない確認だけにする。
     */
    readonly probe: (
      endpointUrl: string,
      timeoutMs: number,
    ) => Promise<{ readonly outcome: ProbeOutcome; readonly durationMs: number }>;
    /**
     * 配備環境から読める、その連携の姿。
     *
     * ⚠️ **値を返させない。** 返すのは方式と、欠けている設定の**名前**まで。
     * ここが値を返す形になった瞬間、秘密が API の応答へ届く道ができる。
     */
    readonly describeEnvironment: (service: IntegrationServiceName) => EnvIntegrationSummary;
    /**
     * 決済の配備側の状態。
     *
     * ⚠️ **鍵そのもの・先頭・末尾を返させない。** 返すのは
     * 「設定されているか」「テストか本番か」「最後に知らせが届いた時刻」まで。
     */
    readonly describePaymentDeployment: () => Promise<PaymentDeploymentStatus>;
    readonly repository: IntegrationRepository & {
      ensureSettings(
        id: string,
        service: IntegrationServiceName,
        environment: IntegrationEnvironment,
      ): Promise<IntegrationSettings>;
    };
    /** このプロセスがどの環境か。⚠️ 設定の `environment` とは別物。 */
    readonly appEnvironment: IntegrationEnvironment;
  };
  /**
   * 送信の運用画面（管理画面・外部連携 指示書 §5）。
   *
   * ⚠️ **読む口と送り直す口を分けて受け取る。** 読む口は本文を返さない型で、
   * 送り直す口は状態を戻すだけ。ひとつにまとめると、画面向けの経路から
   * 本文へ手が届いてしまう。
   *
   * ⚠️ **無い環境では経路ごと生やさない。** 「渡すが中で落ちる」形にすると、
   * 開いた人に 500 が返るだけで、原因が配線の欠けだと分からない。
   */
  readonly walletDeliveries?: {
    readonly admin: WalletDeliveryAdminPort;
    readonly outbox: Pick<WalletDeliveryOutboxPort, 'requeue'>;
  };
  /** 監査ログの閲覧（指示書 §5）。 */
  readonly auditLogs?: AuditLogReadPort;
  readonly idempotency: IdempotencyStore;
  /**
   * 注文と在庫の仮引当（決済 Phase P0・P1）。
   *
   * ⚠️ **手数料率をここで受け取る。** ブラウザからは受け取らない
   * （指示書 §4.2）。既定 0 は「まだ決めていない」の意味で、
   * 決定ではない（`UD-109`）。
   *
   * ⚠️ `internalJobToken` が無ければ内部ジョブの経路を生やさない。
   * 「未設定なら素通し」にすると、設定を忘れた環境で外から在庫を操作できる。
   */
  readonly orders: {
    readonly repository: OrderRepository;
    readonly commonUserLinks: CommonUserLinkRepository;
    readonly random: RandomPort;
    /** ⚠️ 呼び出しのたびに引く。管理画面で変えたら次の注文から効く。 */
    readonly resolvePlatformFeeRateBps: () => Promise<number>;
    readonly reservationMinutes: number;
    readonly internalJobToken?: string | undefined;
  };
  /**
   * 決済（決済 Phase P2）。
   *
   * ⚠️ **無い環境では経路ごと生やさない。** 「渡すが中で落ちる」形にすると、
   * 鍵の設定を忘れた環境で Webhook の口だけが開き、署名を確かめずに
   * 受けるか全部拒否するかのどちらかになる。前者は誰でも
   * 「決済成功」を送れる。
   */
  readonly payments?: {
    readonly gateway: PaymentGatewayPort;
    readonly repository: PaymentRepository;
    readonly provider: string;
    /** この配備が本番の決済を扱うか。⚠️ 事業者の `livemode` と突き合わせる。 */
    readonly expectLivemode: boolean;
    readonly logger: Logger;
  };
  readonly tokenVerifier: TokenVerifierPort;
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
  readonly storage: StoragePort;
  readonly audit: AuditLogPort;
  readonly generateStorageKey: StorageKeyFactory;
  /** 画像の内容ハッシュ計算。実装は `@sengoku/integrations` の `contentHash`。 */
  readonly hashContent: ContentHasher;
  /**
   * Claim（OVEW Wallet 連携）。
   *
   * ⚠️ **既定は無効。** 有効化するのは、相手側の署名器が v1.1 FINAL へ揃い、
   * 固定ベクトルが両システムで一致してから。
   */
  readonly claim?: {
    readonly enabled: boolean;
    readonly claims: ClaimTokenRotationSource;
    readonly tokens: ClaimTokenPort;
    readonly verifier: SenNoKuniHmacVerifier | null;
    readonly logger: Logger;
    readonly rateLimiter: RateLimiterPort;
    /** 1 分あたりの上限（鍵IDごと）。用途で枠を分ける。 */
    readonly getPerMinute: number;
    readonly postPerMinute: number;
    /** 受取ページの前置き。末尾のスラッシュを含めない。 */
    readonly claimBaseUrl: string;
    /**
     * Wallet への配送を有効にするか。
     *
     * ⚠️ **Claim 本体とは別のフラグ。**
     * 有効にすると、受取確定と同時に配送本文が組み立てられ、
     * 組み立てられない作品（長期URLの画像が無い等）は受取が失敗する。
     * 画像の長期URL（Cloudflare R2）が整うまでは無効のままにする。
     */
    readonly deliveryEnabled: boolean;
  };
}

/**
 * アプリケーションのルートモジュール。
 *
 * 機能ごとにコントローラを分けてあるので、
 * Phase 3 以降で注文・受取を足してもここが肥大化しない。
 */
/**
 * 画像アップロードで受け付ける本文の上限。
 *
 * ドメイン側の上限（5MB）より少し大きくしてある。
 * ここで先に切ると Express 既定の 413（HTML）が返り、
 * 統一したエラー契約から外れてしまうため、
 * **判定はドメイン側に任せて、こちらは暴走を止めるだけ**にする。
 */
const RAW_BODY_LIMIT = '8mb';

@Module({})
export class AppModule implements NestModule {
  /**
   * 画像は生のバイト列で受け取る。
   *
   * JSON パーサに通さないのは、画像をテキストとして解釈させないため。
   * 対象を画像の MIME に限定しているので、他のエンドポイントには影響しない。
   */
  configure(consumer: MiddlewareConsumer): void {
    // ⚠️ **すべての経路へ最初に適用する。**
    //    ここより後に置いたミドルウェアのログにも相関IDが乗る。
    consumer.apply(CorrelationMiddleware).forRoutes('*');
    consumer
      .apply(express.raw({ type: ['image/*', 'application/octet-stream'], limit: RAW_BODY_LIMIT }))
      .forRoutes('api/v1/admin/artworks/:id/image', 'api/v1/creator/artworks/:id/image');
  }

  static register(deps: AppDependencies): DynamicModule {
    // ⚠️ **依存が無いときは、経路ごと生やさない。**
    //    「登録はするが呼ばれたら落ちる」形にすると、Nest は起動時に
    //    すべての provider を作るため、Claim を使わない構成まで道連れに落ちる。
    //    実際にそれで既存の API テストが全滅した。
    const claim = deps.claim;
    const integrations = deps.integrations;
    const walletDeliveries = deps.walletDeliveries;
    const auditLogs = deps.auditLogs;
    const internalJobToken = deps.orders.internalJobToken;
    const payments = deps.payments;
    return {
      module: AppModule,
      controllers: [
        HealthController,
        CatalogController,
        PublicListingController,
        AdminCatalogController,
        CreatorCatalogController,
        StaffController,
        StaffInvitationAcceptController,
        OrderController,
        AdminOrderController,
        ...(internalJobToken === undefined || internalJobToken === ''
          ? []
          : [InternalJobsController]),
        ...(payments === undefined ? [] : [CheckoutController, PaymentWebhookController]),
        ...(integrations === undefined ? [] : [IntegrationController]),
        ...(walletDeliveries === undefined ? [] : [WalletDeliveryController]),
        ...(auditLogs === undefined ? [] : [AuditLogController]),
        ...(claim === undefined ? [] : [ClaimController, ClaimReissueController]),
      ],
      providers: [
        {
          provide: HealthService,
          useFactory: () => new HealthService(deps.version, deps.probes ?? []),
        },
        {
          provide: CatalogService,
          useFactory: () =>
            new CatalogService(deps.artworks, deps.listings, deps.clock, deps.storage),
        },
        {
          provide: AdminCatalogService,
          useFactory: () =>
            new AdminCatalogService(
              deps.artworks,
              deps.listings,
              deps.ids,
              deps.clock,
              deps.storage,
              deps.audit,
            ),
        },
        {
          provide: CreatorCatalogService,
          useFactory: (admin: AdminCatalogService) =>
            // ⚠️ 業務規則は `AdminCatalogService` を通す。所有権だけを足す。
            new CreatorCatalogService(admin, deps.artworks, deps.listings),
          inject: [AdminCatalogService],
        },
        {
          provide: ArtworkImageService,
          useFactory: () =>
            new ArtworkImageService(
              deps.artworks,
              deps.storage,
              deps.generateStorageKey,
              deps.audit,
              deps.hashContent,
            ),
        },
        {
          provide: IdempotencyService,
          useFactory: () => new IdempotencyService(deps.idempotency, deps.clock),
        },
        {
          provide: OrderService,
          useFactory: () =>
            new OrderService(
              deps.orders.repository,
              deps.listings,
              deps.artworks,
              deps.orders.commonUserLinks,
              // ⚠️ 決済を繋いでいない配備では null。詳細画面が 500 にならない。
              payments?.repository ?? null,
              deps.clock,
              deps.ids,
              deps.orders.random,
              deps.audit,
              {
                resolvePlatformFeeRateBps: deps.orders.resolvePlatformFeeRateBps,
                reservationMinutes: deps.orders.reservationMinutes,
              },
            ),
        },
        ...(internalJobToken === undefined || internalJobToken === ''
          ? []
          : [
              {
                provide: INTERNAL_JOB_CONFIG,
                useFactory: (): InternalJobConfig => ({ token: internalJobToken }),
              },
            ]),
        ...(payments === undefined
          ? []
          : [
              {
                provide: CheckoutService,
                useFactory: () =>
                  new CheckoutService(
                    deps.orders.repository,
                    payments.repository,
                    payments.gateway,
                    deps.clock,
                    deps.ids,
                    deps.audit,
                    { provider: payments.provider },
                  ),
              },
              {
                provide: PaymentWebhookService,
                useFactory: () =>
                  new PaymentWebhookService(
                    payments.gateway,
                    payments.repository,
                    deps.orders.repository,
                    deps.clock,
                    deps.ids,
                    deps.audit,
                    payments.logger,
                    { provider: payments.provider, expectLivemode: payments.expectLivemode },
                  ),
              },
            ]),
        ...(integrations === undefined
          ? []
          : [
              {
                provide: IntegrationService_,
                useFactory: () =>
                  new IntegrationService_(
                    integrations.repository,
                    deps.ids,
                    deps.clock,
                    deps.audit,
                    integrations.appEnvironment,
                    integrations.probe,
                    integrations.describeEnvironment,
                    integrations.describePaymentDeployment,
                  ),
              },
            ]),
        ...(walletDeliveries === undefined
          ? []
          : [
              {
                provide: WalletDeliveryAdminService,
                useFactory: () =>
                  new WalletDeliveryAdminService(
                    walletDeliveries.admin,
                    walletDeliveries.outbox,
                    deps.clock,
                    deps.audit,
                  ),
              },
            ]),
        ...(auditLogs === undefined
          ? []
          : [
              {
                provide: AuditLogQueryService,
                useFactory: () => new AuditLogQueryService(auditLogs),
              },
            ]),
        {
          provide: StaffService,
          useFactory: () =>
            new StaffService(
              deps.staffMembers,
              deps.staffInvitations,
              deps.ids,
              deps.clock,
              deps.audit,
            ),
        },
        ...(claim === undefined
          ? []
          : [
              {
                provide: ClaimService,
                useFactory: (idempotency: IdempotencyService) =>
                  new ClaimService(
                    claim.claims,
                    claim.tokens,
                    deps.clock,
                    idempotency,
                    // 無効なら planner ごと渡さない。「渡すが中で何もしない」に
                    // すると、無効なのに本文を組み立てて落ちる経路が残る。
                    claim.deliveryEnabled
                      ? new WalletDeliveryPlanner(deps.ids, deps.storage, deps.hashContent)
                      : null,
                  ),
                inject: [IdempotencyService],
              },
              SenNoKuniHmacGuard,
              ClaimRateLimitGuard,
              {
                provide: ReissueService,
                useFactory: () =>
                  new ReissueService(
                    claim.claims,
                    claim.tokens,
                    deps.clock,
                    deps.audit,
                    claim.claimBaseUrl,
                  ),
              },
              {
                provide: CLAIM_RATE_LIMIT_CONFIG,
                useFactory: (): ClaimRateLimitConfig => ({
                  limiter: claim.rateLimiter,
                  clock: deps.clock,
                  getPerMinute: claim.getPerMinute,
                  postPerMinute: claim.postPerMinute,
                }),
              },
              {
                provide: CLAIM_HMAC_CONFIG,
                useFactory: (): ClaimHmacConfig => ({
                  verifier: claim.verifier,
                  clock: deps.clock,
                  logger: claim.logger,
                  // 既定は無効。有効化は相手側の署名器が揃ってから。
                  enabled: claim.enabled,
                }),
              },
            ]),
        {
          // ✅ 認可はガードで一括保護する。ルート個別にチェックを書かない。
          //    グローバル登録なので、新しいエンドポイントを足しても
          //    自動的に保護対象になる（宣言を忘れたら通らない向き）。
          provide: APP_GUARD,
          useFactory: (reflector: Reflector) =>
            new AuthGuard(reflector, deps.tokenVerifier, deps.accounts),
          inject: [Reflector],
        },
      ],
    };
  }
}
