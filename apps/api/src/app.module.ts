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
  EmailHashPort,
  ClockPort,
  IdGeneratorPort,
  ListingRepository,
  StoragePort,
  StaffInvitationRepository,
  StaffMemberRepository,
  IntegrationRepository,
  LegalDocumentRepository,
  LegalConsentRepository,
  PaymentCredentialRepository,
  SecretCipherPort,
  AuditLogReadPort,
  OrderRepository,
  OrderNoteRepository,
  SettlementSettingsRepository,
  CollectibleRepository,
  EntitlementIssuanceRepository,
  RefundRepository,
  PayoutRepository,
  CreatorProfileRepository,
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
import { canDiscloseCheckoutTerms } from '@sengoku/domain';
import type { SenNoKuniHmacVerifier } from '@sengoku/integrations';
import type { Logger } from '@sengoku/observability';

/**
 * 何も書き出さないログ。
 *
 * ⚠️ **本番で使わない。** 決済を繋いでいない配備（手元・E2E）で、
 * 返金の経路が logger を要求するために置いてある。決済を繋いだ配備では
 * `payments.logger` が渡るので、こちらは使われない。
 */
const SILENT_LOGGER: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  child: () => SILENT_LOGGER,
  // ⚠️ pino の全面を実装しない。使うのは上の 5 つと `child` だけ。
} as unknown as Logger;
import { AuthGuard } from './auth/auth.guard';
import { ClaimController } from './claim/claim.controller';
import { ClaimService } from './claim/claim.service';
import { WalletAutoDeliveryService } from './claim/auto-delivery.service';
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
import { OrderSupportService } from './order/order-support.service';
import {
  COLLECTIBLE_CONFIG,
  CollectibleController,
  type CollectibleConfig,
} from './order/collectible.controller';
import {
  EntitlementIssuanceService,
  ISSUANCE_CONFIG,
  type IssuanceConfig,
} from './order/issuance.service';
import { RefundService } from './order/refund.service';
import {
  AdminSettlementController,
  SETTLEMENT_CONFIG,
  type SettlementConfig,
} from './settlement/settlement.controller';
import { AdminPayoutController } from './settlement/payout.controller';
import {
  CreatorProfileController,
  PROFILE_CONFIG,
  type ProfileConfig,
} from './catalog/profile.controller';
import { PAYOUT_CONFIG, PayoutService, type PayoutConfig } from './settlement/payout.service';
import { CheckoutService } from './order/checkout.service';
import { PaymentWebhookService } from './order/webhook.service';
import { PaymentWebhookController } from './order/webhook.controller';
import {
  INTERNAL_JOB_CONFIG,
  InternalJobsController,
  type InternalJobConfig,
} from './order/internal-jobs.controller';
import {
  AdminLegalController,
  LegalConsentController,
  PublicLegalController,
} from './legal/legal.controller';
import { LegalService } from './legal/legal.service';
import { PaymentCredentialController } from './payment-credential/payment-credential.controller';
import {
  PaymentCredentialService,
  type PaymentCredentialConfig,
} from './payment-credential/payment-credential.service';
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
  /**
   * 法務文書（利用規約・プライバシーポリシー・特商法表記）。
   *
   * ⚠️ **無い環境では経路ごと生やさない。** 公開ページの口だけが開いて
   * 500 を返すより、404 のほうが原因が分かる。
   */
  /**
   * 決済資格情報の世代（`UD-118`）。
   *
   * ⚠️ **暗号鍵が無い環境では渡さない。** 「渡すが中で落ちる」形にすると、
   * 画面を開いた人に 500 が返るだけで、原因が鍵の欠けだと分からない。
   */
  readonly paymentCredentials?: {
    readonly repository: PaymentCredentialRepository;
    readonly cipher: SecretCipherPort;
    readonly config: PaymentCredentialConfig;
  };
  readonly legalDocuments?: {
    readonly documents: LegalDocumentRepository;
    /** 規約への同意（`UD-126`）。 */
    readonly consents: LegalConsentRepository;
  };
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
    /** 問い合わせの対応メモ（`UD-121`）。⚠️ 追記のみ。 */
    readonly notes: OrderNoteRepository;
    readonly commonUserLinks: CommonUserLinkRepository;
    readonly random: RandomPort;
    /** ⚠️ 呼び出しのたびに引く。管理画面で変えたら次の注文から効く。 */
    readonly resolvePlatformFeeRateBps: () => Promise<number>;
    /**
     * 注文時点で施行されていた規約の版（`UD-126`）。
     *
     * ⚠️ **同意を確かめる口ではない。** 注文へ「何が表示されていたか」を
     * 残すためだけに引く。未公開なら `null` を返し、**注文を止めない**。
     */
    readonly resolveEffectiveTerms: () => Promise<{
      readonly id: string;
      readonly version: number;
    } | null>;
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
    /**
     * 返金を受け付ける期限を決める（`UD-104`）。
     *
     * ⚠️ **決済確定のたびに引く。** 引いた値は注文へ焼き付けられるので、
     * あとから設定を変えても過去の注文は動かない。
     */
    readonly resolveRefundableUntil: (paidAt: Date) => Promise<Date | null>;
    readonly logger: Logger;
  };
  readonly tokenVerifier: TokenVerifierPort;
  /**
   * 照合用のメール値を作る口（`UD-121`）。
   *
   * ⚠️ **省略できない。** 「無ければ素のハッシュ」という逃げ道を作ると、
   * 配備によって保護の強さが変わる。鍵の無い配備でも実装は渡し、
   * その実装が `null` を返す形にしてある。
   */
  readonly emailHasher: EmailHashPort;
  /**
   * 返金と精算の設定（`UD-104` / `UD-119`）。
   *
   * ⚠️ **省略できない。** 無いと返金の期限が付かず、購入者都合の返金が
   * 一切通らなくなる。それに気づくのは問い合わせが来たとき。
   */
  readonly settlement: SettlementSettingsRepository;
  /**
   * 返金の記録（`UD-104` / `UD-120`）。
   *
   * ⚠️ **省略できない。** 無いと、事業者の画面から返金されたときに
   * 追随できず、返金済みの注文が「お支払い済み」のまま精算に乗る。
   */
  readonly refunds: RefundRepository;
  /**
   * 受取権の発行（P0-1）。
   *
   * ⚠️ **省略できない。** 無いと、決済が済んだ注文から受取権が生まれず、
   * Claim も Wallet 配送も一度も動かない。
   */
  readonly issuance: EntitlementIssuanceRepository;
  /**
   * ご自分が受け取ったもの（P0-3）。
   *
   * ⚠️ **省略できない。** 無いと、買った方が自分の持ち物を確かめられない。
   */
  readonly collectibles: CollectibleRepository;
  /**
   * 作家さまへの精算（`UD-119`）。
   *
   * ⚠️ **省略できない。** 無いと締めも確定もできず、作家さまへの
   * お支払いが記録として残らない。
   */
  readonly payouts: PayoutRepository;
  /**
   * 作家さまの表示名（決定 2026-08-20）。
   *
   * ⚠️ **省略できない。** 無いと名乗れず、公開ページで作家さまが
   * 匿名のままになる。
   */
  readonly profiles: CreatorProfileRepository;
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
    const legalDocuments = deps.legalDocuments;
    const paymentCredentials = deps.paymentCredentials;
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
        // 返金と精算の設定（`UD-104` / `UD-119`）。⚠️ 変更はオーナー限定。
        AdminSettlementController,
        AdminPayoutController,
        // 自分の表示名（決定 2026-08-20）。⚠️ 自分の分しか触れない。
        CreatorProfileController,
        // ご自分が受け取ったもの（P0-3）。⚠️ 自分の分しか見えない。
        CollectibleController,
        ...(internalJobToken === undefined || internalJobToken === ''
          ? []
          : [InternalJobsController]),
        ...(payments === undefined ? [] : [CheckoutController, PaymentWebhookController]),
        ...(integrations === undefined ? [] : [IntegrationController]),
        ...(walletDeliveries === undefined ? [] : [WalletDeliveryController]),
        ...(auditLogs === undefined ? [] : [AuditLogController]),
        ...(legalDocuments === undefined
          ? []
          : [PublicLegalController, AdminLegalController, LegalConsentController]),
        ...(paymentCredentials === undefined ? [] : [PaymentCredentialController]),
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
          // 返金と精算の設定（`UD-104` / `UD-119`）。
          // ⚠️ 変えられるのは「これから」だけ。過去の記録は焼き付けてある。
          provide: SETTLEMENT_CONFIG,
          useFactory: (): SettlementConfig => ({
            repository: deps.settlement,
            // ⚠️ 環境はプロセスに固定する。要求から受け取れるようにすると、
            //    本番から staging を書き換えられる。
            appEnvironment: deps.integrations?.appEnvironment ?? 'staging',
            audit: deps.audit,
          }),
        },
        {
          provide: PROFILE_CONFIG,
          useFactory: (): ProfileConfig => ({
            repository: deps.profiles,
            audit: deps.audit,
          }),
        },
        {
          // 精算（`UD-119`）。⚠️ 金額を人が書き換える口を足さないこと。
          provide: PAYOUT_CONFIG,
          useFactory: (): PayoutConfig => ({
            repository: deps.payouts,
            settings: deps.settlement,
            // ⚠️ 環境はプロセスに固定する。要求から受け取らない。
            appEnvironment: deps.integrations?.appEnvironment ?? 'staging',
            clock: deps.clock,
            ids: deps.ids,
            audit: deps.audit,
          }),
        },
        PayoutService,
        {
          /*
            ご自分が受け取ったもの（P0-3）。

            ⚠️ **管理側の読み取りモデルを流用していない。** あちらは購入者・
               金額・手数料まで載る。流用すると、画面に出さないつもりの値が
               応答には載っている状態になる。
          */
          provide: COLLECTIBLE_CONFIG,
          useValue: {
            repository: deps.collectibles,
            storage: deps.storage,
          } satisfies CollectibleConfig,
        },
        {
          /*
            受取権の発行（P0-1）。

            ⚠️ **決済を繋いでいない配備でも配る。** 掃き出しの口と、
               受取権の件数と在庫カウンタの突き合わせは、決済に依らず要る。
          */
          provide: ISSUANCE_CONFIG,
          useValue: {
            repository: deps.issuance,
            audit: deps.audit,
            clock: deps.clock,
          } satisfies IssuanceConfig,
        },
        EntitlementIssuanceService,
        {
          /*
            返金の実行（`UD-104` / `UD-120`）。
            ⚠️ **決済を繋いでいない配備でも配る。** 返金の記録を読む口
               （`GET :id/refunds`）は決済に依らず要る。投げる先が無い
               ときは、送信の直前で断る（黙って成功にしない）。
          */
          provide: RefundService,
          useFactory: () =>
            new RefundService(
              deps.refunds,
              payments?.gateway ?? null,
              deps.clock,
              deps.ids,
              deps.audit,
              /*
                ⚠️ **決済を繋いでいない配備では書き出さない。** この経路で
                   ログに載るのは注文IDと符号だけだが、送る先が無い配備で
                   出力を増やす理由も無い。
              */
              payments?.logger ?? SILENT_LOGGER,
            ),
        },
        {
          // 注文の検索・経過・対応メモ（`UD-121`）。
          // ⚠️ ここは読み取りと追記だけ。状態を変える処理を足さない。
          provide: OrderSupportService,
          useFactory: () =>
            new OrderSupportService(
              deps.orders.repository,
              deps.orders.notes,
              // ⚠️ 決済を繋いでいない配備では null。経過から決済の行が消えるだけ。
              payments?.repository ?? null,
              deps.emailHasher,
              deps.clock,
              deps.ids,
              deps.audit,
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
                resolveEffectiveTerms: deps.orders.resolveEffectiveTerms,
                reservationMinutes: deps.orders.reservationMinutes,
              },
            ),
        },
        ...(internalJobToken === undefined || internalJobToken === ''
          ? []
          : [
              {
                provide: INTERNAL_JOB_CONFIG,
                /*
                  ⚠️ **自動配送は `optional` で受け取る。** Wallet へ繋いで
                     いない配備では provider ごと存在しないため、必須にすると
                     起動しない。掃き出しの口は生やしたまま 0 件を返す。
                */
                inject: [{ token: WalletAutoDeliveryService, optional: true }],
                useFactory: (
                  autoDelivery: WalletAutoDeliveryService | undefined,
                ): InternalJobConfig => ({
                  token: internalJobToken,
                  /*
                    ⚠️ **`undefined` を `null` へ寄せる。** 見つからない依存に
                       Nest が渡すのは `undefined` で、`null` ではない。
                       受け取る側が `=== null` で見ていると素通りし、
                       無い相手のメソッドを呼んで 500 になる。
                  */
                  autoDelivery: autoDelivery ?? null,
                }),
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
                    {
                      provider: payments.provider,
                      /*
                        ⚠️ **法務文書を繋いでいない配備では、売らせない。**
                           「確かめられないから通す」にすると、表示義務を
                           果たせないまま販売できてしまう。配線の欠けは
                           運営が直せるが、法に触れた販売は取り消せない。
                      */
                      canDiscloseCheckoutTerms: async () => {
                        if (legalDocuments === undefined) {
                          return false;
                        }
                        const effective = await legalDocuments.documents.findEffective(
                          'tokushoho',
                          deps.clock.now(),
                        );
                        return canDiscloseCheckoutTerms(effective?.tokushoho ?? null);
                      },
                    },
                  ),
              },
              {
                provide: PaymentWebhookService,
                inject: [
                  RefundService,
                  EntitlementIssuanceService,
                  // ⚠️ Wallet へ繋いでいない配備では存在しない。
                  { token: WalletAutoDeliveryService, optional: true },
                ],
                useFactory: (
                  refundService: RefundService,
                  issuanceService: EntitlementIssuanceService,
                  autoDelivery: WalletAutoDeliveryService | undefined,
                ) =>
                  new PaymentWebhookService(
                    payments.gateway,
                    payments.repository,
                    deps.orders.repository,
                    deps.clock,
                    deps.ids,
                    deps.audit,
                    payments.logger,
                    {
                      provider: payments.provider,
                      expectLivemode: payments.expectLivemode,
                      resolveRefundableUntil: payments.resolveRefundableUntil,
                    },
                    // ⚠️ 事業者の画面からの返金に追随する（`UD-120`）。
                    refundService,
                    // ⚠️ 決済確定の直後に受取権を作る（P0-1）。
                    issuanceService,
                    // ⚠️ 登録済みの方には、その場で届けにいく（P0-2）。
                    //    ⚠️ 見つからない依存に Nest が渡すのは `undefined`。
                    autoDelivery ?? null,
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
        ...(paymentCredentials === undefined
          ? []
          : [
              {
                provide: PaymentCredentialService,
                useFactory: () =>
                  new PaymentCredentialService(
                    paymentCredentials.repository,
                    paymentCredentials.cipher,
                    deps.clock,
                    deps.audit,
                    paymentCredentials.config,
                  ),
              },
            ]),
        ...(legalDocuments === undefined
          ? []
          : [
              {
                provide: LegalService,
                useFactory: () =>
                  new LegalService(
                    legalDocuments.documents,
                    deps.clock,
                    deps.audit,
                    legalDocuments.consents,
                  ),
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
              /*
                Wallet への自動配送（P0-2）。

                ⚠️ **配送を有効にしていない配備では配らない。** 「渡すが中で
                   何もしない」にすると、無効なのに本文を組み立てて落ちる
                   経路が残る（`ClaimService` の planner と同じ扱い）。
              */
              ...(claim.deliveryEnabled
                ? [
                    {
                      provide: WalletAutoDeliveryService,
                      useFactory: () =>
                        new WalletAutoDeliveryService(
                          claim.claims,
                          new WalletDeliveryPlanner(deps.ids, deps.storage, deps.hashContent),
                          deps.clock,
                          deps.audit,
                        ),
                    },
                  ]
                : []),
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
            new AuthGuard(
              reflector,
              deps.tokenVerifier,
              deps.accounts,
              deps.clock,
              deps.emailHasher,
            ),
          inject: [Reflector],
        },
      ],
    };
  }
}
